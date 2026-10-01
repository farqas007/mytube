# Third-Party Notices

This document lists third-party components used by the MyTube project.
It is not a license grant. License texts for these components are
available from the respective projects' official sources.

## Firebase JS SDK (v10.12.0)

Firebase App, Authentication, and Cloud Firestore SDKs are loaded at
runtime from Google's gstatic CDN (Apache License 2.0):

- https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js
- https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js
- https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js

Loaded by `firebase.js` and consumed via `auth`/`db` in the application
pages. The SDK files are not bundled into this repository.

## Google Material Design Icons - "mic" (capacity icon)

The voice-search button uses the inline SVG paths of Google's Material
Design "mic" icon (Apache License 2.0). The paths are inlined directly in:

- `index.html`
- `watch.html`
- `library.html`
- `subscriptions.html`

The icon SVGs are embedded in the markup and are not separate files.

## YouTube Data API v3 and YouTube Embedded Player

- Search results and recommended videos are fetched through the YouTube
  Data API v3, proxied server-side by the Cloudflare Worker
  (`worker.js`) using an API key configured via environment variables.
- `watch.html` embeds YouTube videos through the privacy-enhanced
  `youtube-nocookie.com` player iframe with a "Watch on YouTube"
  fallback link.

Use of the YouTube API is subject to the YouTube Terms of Service and
Google's API Terms of Service. This project is an independent, unofficial
project and is not affiliated with, endorsed by, or sponsored by Google
LLC or YouTube. YouTube is a trademark of Google LLC.

## YouTube Live Chat

When the video being watched is currently live, `watch.html` displays the
**real YouTube Live Chat** for that broadcast in a read-only panel in the
right-hand column:

- Messages are read through the YouTube Live Streaming API
  (`liveChat/messages.list`), proxied server-side by the Cloudflare Worker
  (`worker.js`) and, for local development, by `youtube-server/server.js`,
  using the same server-side API key as the rest of the integration. The API
  key is never exposed to the browser.
- This chat is **YouTube's own live chat**, shown as-is. MyTube does not host,
  store, moderate, mirror or archive it, and sends no messages on your behalf.
  Nothing here is written to Firestore.
- The panel is read-only: there is no composer, and MyTube has no
  message-sending endpoint. Posting in live chat requires authenticated
  access to YouTube itself and is out of scope for this project.
- Message content is third-party user-generated content displayed verbatim,
  attributed in the panel with a "Chat provided by YouTube" link to
  https://www.youtube.com/live_chat.
- Live chat is polled on YouTube's own `pollingIntervalMillis` interval, and
  upstream requests are shared between viewers of the same stream to limit
  API usage.

## DejaVu Sans Bold (build-time font)

`create_mytube_icon.py` (the script used to generate `mytube-icon.png`)
attempts to load `DejaVuSans-Bold.ttf` from the system font directory,
falling back to `LiberationSans-Bold.ttf` when DejaVu is absent. These
fonts are loaded from the local build machine and are **not** distributed
in this repository or deployed as part of the public site.

---

All other project assets (artwork, interface, branding) are original and
project-owned.