# Changelog

## Unreleased

- Popup explains completion, Stop, assets and conversation certainty from session capabilities.
  Secondary identity and capability fields sit in Conversation details.
- Guided Generic setup reuses element selection, local-model detection and structural validation.
  Setup dispatch targets the exact permitted browser document; closing cancels unfinished selection.
- Element picker shows a tracking outline and keyboard instructions. Arrow keys select suggested
  elements, parents and children; Enter chooses without activating Send; Escape cancels.
- Binding saves retain their original route and reject navigation during storage waits.
- Saved-binding controls remove one unchanged profile or explicitly revoke site access. Active
  requests block management; browser refusal remains visible; revocation preserves profiles.
- Recovery shows submission and interruption facts, opens the existing conversation, and offers
  selected-response completion for an active Generic manual request without prompt replay.
  Selection rechecks conversation ownership around waits before Stop or acceptance.

- Paste & Pair submits only the current pairing intent. Endpoint/token edits, manual pairing,
  cancellation, disconnect and Reconnect invalidate delayed clipboard results.
- Token field and three controls use normal flex flow. Rendered keyboard/zoom acceptance remains
  open in `TODO.md`.
- Local-model requests reject redirects before forwarding prompts.
- Patched transitive `fast-uri` advisory without changing direct dependency ranges.

## 0.6.7

- Preserved newer endpoint and token edits across delayed state/clipboard responses, made connected-state errors visible, and resurfaced repeated errors after recovery.
- Added a deterministic integrity-checked release ZIP with the project license and complete bundled-dependency notices.
- Rebuilt the popup around a per-conversation list with inline bind and unbind controls, replacing the select-plus-detail inspection flow, and dropped full-popup HTML rerenders in favour of targeted DOM updates so open controls, selections, and drafts survive polling.
- Validated the loopback endpoint in the popup before pairing, added a pairing-token reveal control, collapsed the pairing form once paired, scoped connection and binding errors to the card that produced them, and made every error dismissible.
- Kept the popup within Chrome's popup height, gave the connection state and each row an explicit status colour, and made buttons distinguish primary, neutral, and destructive actions.
- Added the `favicon` permission so conversation rows show the provider icon from Chrome's local favicon cache without any network request, falling back to a drawn monogram.
- Added the `clipboardRead` permission for an explicit popup Paste control; the clipboard is read only on that press and the value stays in the in-memory pairing draft.
- Reshaped the popup around the fact that a binding persists and follows bachata-driven conversation changes: once bound it shows that conversation alone, the full list is behind Change conversation, and the endpoint and token controls are hidden behind the connection status until they are needed or the bridge is not connected.
- Cut repeated popup detail: the provider's own host, the status reason a badge already states, the endpoint scheme and path, and the standing subtitle are no longer drawn once they add nothing, and Inspect tabs is now Refresh tabs to match the wording of the status reasons.

- Hardened ChatGPT and Claude pre-submit cancellation so interrupts are sticky even when they race content-script dispatch, cancel selector healing, and cannot later click Send.
- Re-attest deadline, document, conversation, composer, prompt text, and Send control immediately before built-in submission; provider navigation during preparation now fails closed.
- Require a stable built-in provider-idle interval as well as stable response text before completion, and bound interruption-time selector healing by the Stop deadline.
- Preserved one request lifecycle and absolute deadline across Generic response-selector healing, re-anchored multi-block assistant responses, and made selector provenance field-specific instead of profile-wide.
- Added explicit Generic submission/completion/interruption/conversation capability state, fail-closed manual-completion quarantine, and transient Stop observation without treating structural validation as lifecycle confirmation.
- Made ChatGPT and Claude interruption require positive Stop/lifecycle confirmation; uncertain capture or cancellation quarantines the exact conversation until a completed lifecycle or fresh conversation is confirmed.
- Added stable-release gates for built-in and Generic browser targets without telemetry or remote diagnostics.
- Hardened generic selector healing for localized and accessible icon-only browser controls by allowing only labeled structurally compatible controller-enumerated candidates, rejecting known conflicting or duplicate cross-role assignments, healing Send before synthetic Enter fallback, and preserving compatibility with older healer decisions.
- Added explicit generic New Conversation binding/auto-heal, observable fresh-conversation attestation, same-document reload detection, and exact-tab recycling for repeated built-in browser iterations.
- Added a 15-second generic generation-lifecycle acquisition deadline so visible responses without trustworthy Stop/generation evidence fail closed instead of consuming the full model-turn timeout.
- Added behavioral generic freshness/lifecycle checks and strengthened structural verification for fresh provisioning.
- Added a fail-closed maintained-source exporter/validator. Source deliveries keep the required root `package-lock.json`, but exclude nested or alternate-package-manager locks, build/test/runtime/cache artifacts, nested archives, generated reports, VCS metadata, and symlinks.
- Source verification no longer writes generated JSON reports into the project tree, preventing validation itself from contaminating a later source export.

- Serialized generic binding-profile mutations and generic registration snapshots in the background worker, rejected malformed stored locator recipes before DOM resolution, made route specificity win over stale wildcard validation state, single-flighted document-scoped auto-heal attempts, required a saved Stop-control capability for managed readiness, detected live provider-side generation, and required observed stop confirmation before interruption is acknowledged.
- Reserved generic and local-model runtime messages for their dedicated background listeners so the broad message dispatcher cannot race them with an undefined response.
- Added an explicitly bound generic browser-LLM provider as a first-class Protocol v9 session.
- Added background-proxied LM Studio/Ollama selector healing for built-in and generic providers with candidate-ID-only decisions, configured-model selection, bounded retries, loopback-only endpoints, and manual binding fallback.
- Added cancellable generic text turns without blocking the protocol message queue, same-origin route continuity, cheap readiness probes, and explicit rejection of unsupported image upload.
- Kept generic-provider filesystem access outside Chrome; repository context and mutations remain VS Code controller responsibilities.
- Stored generic bindings by origin and conversation route, added bounded assistant-response locator selection, and added response-only healing that retries capture without resending the prompt.
- Preserved newly saved route profiles under the per-origin cap and aligned custom loopback LM Studio/Ollama endpoint handling with extension host permissions.

## 0.6.5

- Added an exact-release Chrome gate for alarm-backed reconnect after a real Manifest V3 service-worker shutdown.
- Required evidence for long-delay retry, automatic worker restart, missed-alarm recovery, Chrome restart recovery, duplicate-alarm prevention, and retry cancellation after reconnect.

## 0.6.4

- Preserve automatic bridge reconnection across Manifest V3 service-worker suspension with a persisted Chrome alarm.
- Restore pending reconnect schedules when the background worker starts again.
- Clear reconnect alarms and persisted retry state after connection, manual reconnect, pairing, or disconnect.

## 0.6.3

- Added a dedicated polite live region for provider conversation bind and unbind changes.
- Preserved the bound-conversation announcement outside popup rerenders.

Stable release requires `docs/LIVE_SMOKE_TEST.md`.

## 0.6.2

- Ignored generated `dist/` output so source deliveries cannot accidentally include build artifacts.

Stable release requires `docs/LIVE_SMOKE_TEST.md`.

## 0.6.1

- Removed the persistent connection token from popup state and raised production coverage gates.
- Stopped buffered asset transfers immediately after cancellation and added failure-path coverage for discovery, validation, HTTP errors, size mismatches, stale requests, and invalid popup operations.
- Added actionable popup readiness for ready, unauthenticated, not-ready, busy, failed, disconnected, and uninspected tabs.
- Added tab ID, URL, and stable conversation identity.
- Preserved endpoint, token, focus, selection, and scroll during polling.
- Rejected non-ready selection in both popup and background code.
- Bound persistent tokens to the exact Chrome extension origin.
- Added strict loopback endpoint validation and recovery from invalid saved state.
- Added behavioral popup tests and independent per-file coverage gates for every core module and production entry.
- Added production-entry coverage for pairing, provider registration, selection, discovery persistence, disconnect, and pre-submit attachment cleanup.
- Clears selected, registered, and handled provider state when a bound tab navigates to an unsupported site or a non-HTTPS URL on a provider hostname.
- Uses one HTTPS-aware provider URL classifier for recognition and canonical conversation validation.
- Rejects nonempty provider composers before submission, cleans staged content after pre-submit failures, and permanently blocks the page document when cleanup cannot be verified.
- Allows every discovered tab to be inspected while binding only ready tabs, supports Enter-to-pair, announces connection state, and follows the browser color scheme.
- Separates inspected and bound conversations, adds explicit bind/unbind actions, and rejects ambiguous page-wide attachment inputs without modifying them.
- Scopes provider attachments to the active composer, permits only ChatGPT’s exact detached upload control, and scopes Claude Send and Stop controls to the active composer region.
- Centralizes provider-control association in a shared 100%-covered module without weakening production-entry gates.
- Removed obsolete implementation reports and versioned smoke-test copies.

Stable release requires `docs/LIVE_SMOKE_TEST.md`.

## 0.6.0

- Added Browser Protocol v8, cancellable provider provisioning, bounded concurrency, replay, and production content-script tests.

## 0.5.0

- Added the Browser Protocol v7 provisioning baseline.
