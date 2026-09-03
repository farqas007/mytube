# Firestore Integration Notes (Phase 6 — documentation only)

Firestore (`db`) is currently configured and exported in `firebase.js` but is **not yet used** by any page.

All current engagement data (comments, likes/dislikes, saved videos, subscriptions) is stored in **localStorage** and is intentionally local to the browser.

## Before enabling Firestore writes (future phase)

- **Define restrictive Firestore Security Rules first.** Enable reads/writes only for the authenticated user's own data (e.g. `request.auth.uid == resource.data.uid`). Never deploy with open `allow read, write: if true;` rules.
- Do not write API keys or Firebase config secrets into Firestore documents; the client config in `firebase.js` is public by design for the Firebase web SDK and must be paired with rules, never treated as a secret.
- Wire `db` into `watch.js` / homepage only after the rules above are enforced, so client-side data cannot be forged or read by other users.
- Keep localStorage as an offline/local fallback during migration.

No Phase 6 code writes to Firestore.

---

## STATUS (completion phase)

The comments system remains **localStorage-based** and fully working. Firestore writes
are intentionally NOT enabled from the browser yet, for two reasons:

1. The live Firestore **security rules for this project are not verified** from the
   build environment. Shipping unverified client writes risks silent permission errors
   (breaking the working comment UI) and, if rules are permissive, lets users forge or
   overwrite each other's comments.
2. The project's own guidance (above) requires restrictive rules to be deployed FIRST.

The correct, ready-to-implement upgrade path is below. It should be done as a separate,
testable phase — not bolted onto the current localStorage system in a single change.

## Exact recommended Firestore design (ready to implement)

### Collection / document shape — `comments` collection, one doc per comment:

```js
// Firestore doc in collection "comments"
{
  videoId: "yt:abc123" | "ghajini",   // storageKey() of the target video
  userId: "firebase-uid",             // auth.currentUser.uid
  author: "display-name or email-local",
  text: "plain text — render via textContent only (never innerHTML)",
  createdAt: firebase.firestore.FieldValue.serverTimestamp() // or Date.now()
}
```

Optionally index by `videoId` (composite index on `[videoId, createdAt]`) so
`query(collection(db, "comments"), where("videoId", "==", key), orderBy("createdAt", "desc"))`
works.

### Security rules (Firestore Console → Rules):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /comments/{doc} {
      // Anyone signed in may create a comment they own.
      allow create: if request.auth != null
                    && request.resource.data.userId == request.auth.uid
                    && request.resource.data.text.size() > 0
                    && request.resource.data.text.size() <= 2000;
      // Read comments for any video (public viewing).
      allow read: if true;
      // Only the owner may update/delete their own comment.
      allow update, delete: if request.auth != null
                            && resource.data.userId == request.auth.uid;
    }
  }
}
```

### Frontend wiring (in `watch.js`, replacing/backing the localStorage path):

- Keep `loadComments/saveComments` as the localStorage fallback.
- On `mytube-auth-change` and on video load, subscribe once per video with
  `onSnapshot(query(...), (snap) => set state + renderComments())` and
  `unsubscribe()` when navigating away (guard with `document.body.contains`),
  to avoid duplicate listeners.
- Posting: `addDoc(collection(db, "comments"), {...})` inside try/catch; on error
  fall back to the localStorage `addComment` path. Only re-enable the input after the
  write settles (prevents duplicate posts).
- Keep the existing ownership/delete checks (`comment.userId === uid`) — they already
  use the Firebase UID, so they map directly to the Firestore fields above.

Do this as its own tested phase once the Firestore database and rules are confirmed in
the Firebase console for `mytube-827d2`.
