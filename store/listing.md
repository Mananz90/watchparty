# Chrome Web Store listing — Watchparty

## Item name
Watchparty — Free Sync & Chat for Netflix, Hotstar, Prime Video

## Summary (132 char max)
Watch Netflix, Hotstar & Prime Video together with friends — synced playback, chat, reactions, host controls. Free, no account needed.

## Detailed description

Watchparty lets you and your friends watch the same movie or show together, in perfect sync, on Netflix, Hotstar, or Prime Video — completely free.

Each person needs their own subscription to the streaming service. Watchparty doesn't share or re-stream video from one account to another — it just keeps everyone's player in sync and adds a chat panel over the video, the same way you'd watch together in person.

**Features:**
- 🔄 Synced play, pause, and seek across everyone in the room
- 💬 Live group chat with a typing indicator
- 😄 Emoji reactions that float over the video
- 👥 Live viewer list showing who's watching, with a host badge
- 🔒 Optional host-only controls, so only one person can control playback for the group
- 🔗 One-click invite links — no account or sign-up required
- Works on Netflix, Hotstar, and Prime Video

**How it works:**
1. Install the extension and open your show on Netflix, Hotstar, or Prime Video.
2. Click the Watchparty icon, generate a room, and copy the invite link.
3. Send the link to friends — they open it on the same title in their own account and it joins automatically.
4. Press play. Everyone's playback stays in sync, with chat and reactions alongside.

Watchparty is free and independent — not affiliated with Netflix, Amazon Prime Video, Disney+ Hotstar, or Teleparty.

## Category
Social & Communication (or: Fun)

## Permission justifications (for the CWS review form)

**host_permissions (`*.netflix.com`, `*.hotstar.com`, `*.primevideo.com`, `*.amazon.com`)**
Required so the extension's content script can find the page's `<video>` element to read/set playback state (play/pause/current time) and inject the chat/sync overlay UI, only on these streaming domains. On Netflix specifically, an additional MAIN-world content script (`netflix-page-bridge.js`) reads Netflix's own in-page player API to perform seeks the way Netflix's own UI does, since writing the video element's position directly is rejected by Netflix's player. It only calls existing playback controls (seek/play/pause) — it does not read or transmit any account, billing, or viewing-history data.

**storage**
Used to remember the user's last-used room code and display name locally in the browser, purely for convenience across sessions. No account or personal data is stored.

**activeTab / scripting**
Used to inject the sync overlay into the active streaming tab when the user opens the extension popup and clicks Join.

## Single purpose statement
Watchparty's single purpose is to synchronize video playback and provide group chat/reactions between users independently watching the same streaming title, each on their own account.

## Data disclosure (CWS "Privacy practices" tab)
- Does this extension collect or transmit user data? Yes — display name, chat messages, and playback timestamps, sent live to other members of the same watch-party room via the developer's own WebSocket server, in order to provide the core synced-viewing feature. Not sold, not used for advertising, not retained after the session ends.
- Privacy policy URL: https://mananz90.github.io/watchparty/privacy-policy.html
