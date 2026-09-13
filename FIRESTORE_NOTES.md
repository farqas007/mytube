# Firestore Integration Notes (Phase 6 — documentation only)

Firestore (`db`) is configured and exported in `firebase.js`. All per-user
engagement data (subscriptions, saved videos, liked videos, watch history,
playlists) is stored under `users/{uid}/...` and written from the browser; the
**comments** feature additionally uses a shared `comments` collection (public
reads, owner-only writes). `localStorage` is kept as an offline/local fallback
for comments.

## Before enabling NEW Firestore writes (future phase)

- **Define restrictive Firestore Security Rules first.** Enable reads/writes only
  for the authenticated user's own data (e.g. `request.auth.uid == uid`). Never
  deploy with open `allow read, write: if true;` rules.
- Do not write API keys or Firebase config secrets into Firestore documents; the
  client config in `firebase.js` is public by design for the Firebase web SDK and
  must be paired with rules, never treated as a secret.
- Keep localStorage as an offline/local fallback during migration.

---

## STATUS (implementation phase)

The comments system is **Firestore-first with a localStorage fallback**:

- `data.js` exports `subscribeComments`, `addCommentToStore`, `removeCommentById`.
  `subscribeComments` uses `onSnapshot` on `where("videoId", "==", key)` without
  `orderBy` (composite-index-free: results are sorted client-side by the
  client-valued `createdAt` `Timestamp`).
- `watch.js` subscribes once per page at the point the active video is resolved
  (`syncFirestoreComments()` in the local `loadVideo()` path and in
  `renderYtSubViews` for YouTube videos), unsubscribes on `pagehide`, and falls
  back to the existing localStorage save/load path whenever the live subscription
  reports an error (e.g. deployed rules not yet updated) or a Firestore write
  fails. Optimistic temp ids are used while a write is in flight; the snapshot
  refresh replaces them with the real docs.

Local `firestore.rules` now covers both the per-user data
(`users/{uid}/{document=**}`) and the shared `comments` collection (create only
when `request.auth.uid == request.resource.data.userId`, text size 1–2000,
public reads, owner-only update/delete) with a defensive `deny` default for
everything else.

**⚠ On deployment**: the local rules file MUST be uploaded to the Firebase
console before enabling Firestore comment writes, otherwise writes fail and every
page silently drops to the localStorage fallback (comments still work, they just
stay local). Deployed-rule verification requires the Firebase CLI, which is not
available in the build environment.

## Implemented design (reference)

### Collection / document shape — `comments` collection, one doc per comment:

```js
// Firestore doc in collection "comments"
{
  videoId: "yt:abc123" | "ghajini",   // storageKey() of the target video
  userId: "firebase-uid",             // auth.currentUser.uid
  author: "display-name or email-local",
  text: "plain text — render via textContent only (never innerHTML)",
  createdAt: Timestamp (client Timestamp.now())
}
```

- `createdAt` is a **client `Timestamp.now()`**, not `serverTimestamp()`, so
  `where("videoId","==",key)` needs **no composite index** (list is sorted
  client-side in `subscribeComments` by `createdAt`).

### Security rules — `firestore.rules` (already in repo, MUST be deployed):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /comments/{doc} {
      allow create: if request.auth != null
                    && request.resource.data.userId == request.auth.uid
                    && request.resource.data.videoId is string
                    && request.resource.data.videoId.size() > 0
                    && request.resource.data.text is string
                    && request.resource.data.text.size() > 0
                    && request.resource.data.text.size() <= 2000;
      allow read: if true;
      allow update, delete: if request.auth != null
                            && resource.data.userId == request.auth.uid;
    }
    match /{document=**} { allow read, write: if false; }
  }
}
```

### Frontend wiring (watch.js — implemented):

- `loadComments/saveComments` remain as the localStorage fallback.
- `syncFirestoreComments()` subscribes once per page (via `onSnapshot`) at the
  moment the active video is resolved: the local path in `loadVideo()` and the
  `renderYtSubViews()` path for YouTube videos. `pagehide` unsubscribes.
- Posting is Firestore-first with an optimistic temp id; `addCommentToStore`
  failure falls back to localStorage and drops the live subscription back to
  `null` (localStorage source). Deleting mirrors this via `removeCommentById`.
- Ownership checks use the Firebase UID (`comment.userId === uid`), matching the
  rules fields.

Do this as its own tested phase once the Firestore database and rules are confirmed in
the Firebase console for `mytube-827d2`.
