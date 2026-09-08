# Security

No telemetry. `NO_TELEMETRY.md` is authoritative.

The Browser Bridge sees provider pages and the loopback Bachata connection. It has no shell or local filesystem API.

## Transport

- Loopback endpoint only: `ws://127.0.0.1:<1-65535>/bachata-browser-bridge-v9`.
- No endpoint credentials, query, fragment, alternate host, or alternate path.
- Exact Chrome extension origin captured at pairing and stored with the connection token.
- Missing Origin, malformed Origin, and another extension origin are rejected.
- One-use pairing token and persistent connection token.
- Authentication deadline and pre-authentication limits.
- Post-authentication message, byte, rate, queue, and connection limits.
- Strict JSON schemas.
- Server-side masking, fragmentation, control-frame, and UTF-8 checks.

An old connection token without an origin is intentionally invalid and requires re-pairing.

## Provider binding

Every request checks provider, tab, top frame, document token, session ID, canonical URL, and stable conversation identity. Navigation or reload cannot silently bind another conversation.

## Navigation

The `webNavigation` permission is read-only and is used for one thing: to be told, by Chrome, when a bound tab's top-level document or route changes. It replaced a 250 ms poll of the page's own URL, which could not distinguish a route change inside the bound conversation from a subframe, a prerendered document, or a document that had already been replaced.

Only `onCommitted`, `onHistoryStateUpdated` and `onReferenceFragmentUpdated` are subscribed, and only for `frameId === 0` on built-in provider origins and Generic origins the user has explicitly granted. A subframe, a prerendered document, an unsupported origin, and a late event naming a replaced document are all refused before anything is bound or invalidated. Chrome's event timestamps are never compared with the extension's clock.

The permission grants no page access of its own: it reports that a navigation happened, not what the page contains. A Generic origin's grant is re-read at the moment a navigation is handled, so a permission the user has taken back removes the registration rather than being trusted from registration time. `tabs.onReplaced` is adapted the same way, and a replaced tab's work fails rather than transferring: nothing proves the new document is the same conversation.

The popup exposes readiness before selection. The background independently rejects every non-ready selection.

## Popup secrets

The one-use pairing token stays in popup memory until Pair succeeds. It is not written into popup state or extension storage. Connection polling preserves the local draft without echoing it through the background.

The token field is masked until the user presses Show. Clipboard reads happen only on an explicit Paste press and never automatically; a blocked read surfaces an inline message instead of failing silently.

## Provisioning

Stable request IDs, deduplication, concurrency limit, queued and active cancellation, disconnect cleanup, bounded result replay, and retained failed tabs.

## Assets

Explicit fetch only, bounded size, ordered chunks, timeout, cancellation, and SHA-256 completion. Cookies and authenticated URLs remain inside the extension.

## Recovery

Invalid persisted endpoint or token fields are sanitized into a disconnected state. Popup disconnect, reset, and re-pair remain available when initialization fails.

## Residual risk

Provider UI changes may break selectors or lifecycle detection. Live authenticated smoke testing is mandatory before stable release.
