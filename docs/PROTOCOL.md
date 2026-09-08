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

Provisioning is outside the serialized WebSocket control queue.

## Conversation binding

Every send and interrupt binds request, participant, provider, session, tab, frame, document token, canonical URL, and stable conversation identity. All fields must match current registered state.

Provider-status sessions may also publish functional capabilities for submission, completion, interruption, assets, and conversation certainty. Built-in providers publish native capabilities. Generic sessions distinguish verified Send from synthetic Enter, verified lifecycle completion from manual-only completion, confirmed interruption from unavailable interruption, and confirmed from uncertain conversation state. VS Code uses these fields to prevent manual-only or quarantined Generic sessions from entering unattended managed mode.

## Response and assets

Streaming uses submitted, stream, and response events. Interruption uses interrupt and interrupted. Failure uses typed conversation error.

Asset fetch uses start, ordered chunks, and complete; failure or cancellation uses error. Reveal uses reveal and reveal result.

## Compatibility

Stored v4-v8 paths migrate to v9 only when the resulting endpoint passes strict validation. Active transport accepts v9 only.
