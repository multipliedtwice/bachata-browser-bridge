# Browser Protocol v9

Endpoint path: `/bachata-browser-bridge-v9`.

Contract: `protocol/browser-protocol-v9.contract.json`. The VS Code and Browser Bridge copies must match byte for byte.

## Authentication

First connection:

```text
bridge.pair
→ bridge.paired
```

Later connections:

```text
bridge.authenticate
→ bridge.connected
```

Pairing tokens are short-lived and one-use. Pairing stores the exact validated Chrome extension origin with the persistent connection token. Authentication requires both. Legacy unbound tokens require re-pairing.

## Control

Client sends pairing/authentication, ping, provider status and provisioning results, conversation events, asset events, and disconnect.

Server sends acknowledgements, pong, discovery, open/cancel provisioning, send/interrupt, asset commands, and typed errors.

## Provisioning

Every open request has a stable `requestId`.

- duplicate active ID: deduplicate;
- duplicate completed ID: replay bounded cached result;
- cancellation: queued or active;
- maximum active provisioning: 2;
- disconnect: cancel outstanding operations;
- failed created tab: retain.

A non-fresh ChatGPT or Claude open that names a `preferredConversationIdentity` for a real conversation returns to that conversation. A ready tab already on it is reused. A tab on it that is not ready is refused with `PROVIDER_NOT_READY`, so a second tab never races the first. Otherwise a tab opens on the conversation URL and must report the same identity; on a mismatch, such as a deleted conversation, that tab is closed and the open is refused with `OPEN_CONVERSATION_FAILED`. The provider's conversation history stays available to the next turn.

Provisioning is outside the serialized WebSocket control queue.

## Conversation binding

Every send and interrupt binds request, participant, provider, session, tab, frame, document token, canonical URL, and stable conversation identity. All fields must match current registered state.

Provider-status sessions may also publish functional capabilities for submission, completion, interruption, assets, and conversation certainty. Built-in providers publish native capabilities. Generic sessions distinguish verified Send from synthetic Enter, verified lifecycle completion from manual-only completion, confirmed interruption from unavailable interruption, and confirmed from uncertain conversation state. VS Code uses these fields to prevent manual-only or quarantined Generic sessions from entering unattended managed mode.

## Response and assets

Streaming uses submitted, stream, and response events. Interruption uses interrupt and interrupted. Failure uses typed conversation error.

Asset fetch uses start, ordered chunks, and complete; failure or cancellation uses error. Reveal uses reveal and reveal result.

## Compatibility

Stored v4-v8 paths migrate to v9 only when the resulting endpoint passes strict validation. Active transport accepts v9 only.

## Created conversation recovery

The v9 transport also supports these authenticated messages:

| Direction | Message | Fields beyond `type` and `protocolVersion` |
| --- | --- | --- |
| Controller to Bridge | `provider.listRecoverableConversations` | `requestId` |
| Bridge to controller | `provider.listRecoverableConversations.result` | `requestId`, `records` |
| Controller to Bridge | `provider.reopenConversation` | `requestId`, `provider` (`chatgpt` or `claude`), `registryId` |
| Bridge to controller | `provider.openConversation.result` | Existing provisioning result, correlated by `requestId` |
| Bridge to controller | `conversation.binding` | `requestId`, `agentId`, original `sessionId`, promoted `session` |

Each record has exactly `id` (a UUID v4), `provider`, `conversationUrl`, `conversationIdentity`, `createdAt`, and `updatedAt` (integer Unix milliseconds). Titles, page metadata, prompts, replies, credentials, and tab IDs are excluded. Only canonical HTTPS `/c/<id>` ChatGPT routes and `/chat/<id>` or `/chats/<id>` Claude routes qualify. IDs contain 1–128 ASCII letters, digits, underscores, or hyphens. Query strings, fragments, credentials, explicit ports, trailing slashes, encoded path characters, initial pages, and other providers are refused.

The nested `conversationRegistry` has version 1 inside the existing `bachataBridgeState.v8` record. Older pairing, endpoint, selection, and reconnect state keep their existing migration rules. Old handled or selected tabs do not become created-chat records. Normalization drops malformed entries and every conflicting duplicate ID or conversation identity. At most 50 records survive, newest `updatedAt` first, with ascending UUID as the tie breaker. An input array over 1,000 entries or an unknown envelope version is discarded. Fifty records keep recovery small and predictable; older records are evicted, not provider chats deleted.

Only an actual Bridge `tabs.create` on a provider start page creates a provisional marker. Discovery, selection, recycled tabs, and reopening existing URLs do not create one. Up to 16 live markers are retained for 30 minutes, pinned to the initial ready document. They are discarded on document replacement, tab closure, failed provisioning, or worker restart. A provisional marker alone is never recoverable.

The existing initial-transition admission must accept the submitted request's same-tab, same-frame, same-document route change. The Bridge then saves the stable record before acknowledging that transition or publishing `conversation.binding`. The catalogue exposes only successfully saved records. The controller validates request ownership and exact document identity again, promotes its binding without completing the turn, and exposes a `binding` event to its consumer. VS Code awaits workspace-state persistence when consuming that event. This also updates a workflow's exact binding for an existing tab, without classifying that tab as Bridge-created.

Closing a tab clears live routing and selection while retaining its stable record. Disconnecting pairing also retains the registry. A controller calls `listRecoverableConversations(signal?)`, explicitly chooses an ID and provider, then calls `reopenConversation(registryId, provider, signal?)`. No record is selected automatically. The API reuses an inactive matching ready tab or creates a new inactive tab through the existing provisioning queue, injects/verifies scripts, and requires the same provider, canonical URL, identity, and readiness. An active request, authentication failure, unavailable record, redirect, or mismatch refuses recovery. The API sends no prompt and does not fall back to another conversation. Cancellation uses the existing provisioning cancellation message. A reused request ID cannot change its selection.

Recovery restores access to a known conversation URL, not a Chrome window, tab position, unsent draft, model response, or proof that a timed-out turn stopped. Existing interruption, quarantine, and final-response checks still apply. A deleted provider conversation, signed-out account, unsupported route, storage failure, or restart before trusted promotion can prevent recovery. There is no provider-history scraping or Chrome session restoration. Install matching Bridge and extension builds for these added v9 messages; older builds do not implement the recovery APIs.
