# Privacy

No telemetry. `NO_TELEMETRY.md` is authoritative.

Extension-local storage may contain the loopback endpoint, persistent connection token, selected and handled tab/session identifiers, reconnect schedule, saved generic binding profiles, and session-scoped generic registrations. The Bachata endpoint binds the persistent token to the exact Chrome extension origin during pairing.

The bridge does not store a permanent prompt or response archive.

Extension-initiated network traffic is limited to the configured loopback WebSocket endpoint, an explicitly configured loopback LM Studio or Ollama selector-healing endpoint, ChatGPT and Claude navigation opened by the user or provisioning, and explicit built-in-provider asset fetches inside the authenticated browser context. Generic providers are manipulated through the DOM only after exact-origin access is granted.

The popup renders provider icons from Chrome's local favicon cache through the `favicon` permission. That path reads what Chrome already stored and issues no network request; a missing entry falls back to a drawn monogram.

The `webNavigation` permission reports that a bound tab navigated — the tab, the frame, the document identity and the URL — and nothing about page content. Nothing from it is stored: it is read, matched against the bound conversation, and discarded. It replaced a permanent poll of the page's own URL.

The `clipboardRead` permission is used only when the user presses Paste in the popup. The clipboard value is read once into the popup's in-memory pairing draft, is never written to extension storage, and is discarded when pairing succeeds or the popup closes.

No analytics, usage metrics, crash reports, remote logs, fingerprints, or install IDs are sent.
