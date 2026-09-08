# Generic browser provider

## Scope

The generic provider lets an explicitly selected browser-LLM tab participate in Browser Protocol v9 without provider-specific selectors. Browser responses preserve ordered text, quote, and fenced-code segments; image attachments and downloadable browser assets are not supported. Filesystem context and selected text/code specifications are read by the VS Code controller and inserted into managed handoffs; the generic browser extension never receives filesystem access.

## Normal operation

A validated saved binding is reused for each turn. Normal readiness checks only resolve the saved composer and conversation region. They do not submit diagnostic prompts and do not call the local model.

Once a bound tab is registered, the background worker publishes it as a `generic` Protocol v9 session. Send, streamed response replacement, final structured response, cancel, session identity, and same-origin conversation-route changes use the same protocol as built-in browser participants. Arbitrary unbound sites are never auto-discovered. Explicitly bound origins may be revisited or re-registered for the same agent after a reset. The session also publishes functional capability state for submission, automatic completion, interruption, asset support, and conversation certainty. A structurally valid profile without a verified Send control or observable Stop lifecycle remains usable for manual workflows but is not eligible for unattended managed mode.

## One-time binding

Open a browser LLM conversation. Popup -> Other websites and saved bindings -> Set up current website -> allow the displayed origin. Setup targets the current browser document; navigation invalidates that request. Close the popup. Use Auto-detect controls, or choose individual controls in the page panel. Context-menu commands remain advanced repair tools.

Picker: blue outline marks selection. Click an element, or use Up/Down for suggestions,
Left for parent, Right for first child. Enter saves; Escape cancels. Selection consumes
Enter and click without activating the page control. Outline follows scroll and resize.
After selection, focus returns to the setup control.

Controls:

1. composer;
2. conversation region;
3. assistant response/message element when automatic response discovery is unreliable;
4. send button when Enter is unreliable;
5. stop button when one is available while idle. Providers that expose Stop only during generation may be validated without it; Bachata learns and persists the transient Stop locator when generation begins;
6. new-conversation control when the provider will be used for fixed or Until-clean iterations. Auto-detect may supply this control when it is structurally identifiable.

Then validate the binding. Validation is structural and does not send a diagnostic chat message. Binding grants exact-origin optional host access and stores route-scoped profiles locally, with writes serialized by the background worker so concurrent tabs on the same origin cannot overwrite one another. Route specificity is evaluated before validation history, so a route-specific profile being edited is not hidden by an older validated wildcard. Generic registration snapshots are serialized before registration is acknowledged. A page refresh is recovered from the live profile. After a full browser restart, a restored tab on a previously bound origin is re-injected and re-registers from the persistent profile when the exact-origin permission still exists. A tab that was not restored, a revoked permission, or an incompatible route/layout requires explicit user binding again. Malformed legacy or corrupted profiles are rejected by the same structural guard, including every stored locator recipe, before they can reach DOM resolution.

## Recovery order

```text
saved validated profile
manual click-to-bind
bounded auto-detect attempts for the document revision
selected-text response fallback
```

Auto-detect runs only when explicitly requested or after a binding-health failure. Attempts are bounded, rate-limited, and single-flight for each live document revision. Response-only healing preserves the original request nonce, absolute deadline, and already-observed generation lifecycle. Healing one locator records provenance only for that locator and does not reclassify manually bound controls.

## Auto-heal contract

Deterministic code enumerates a bounded set of visible DOM candidates with accessible names, roles, placeholders, geometry, and short text previews. The local model may return only supplied candidate IDs in `bachata-dom-heal-v1` JSON.

CSS, XPath, JavaScript, URLs, coordinates, arbitrary text, and unknown IDs are rejected. JSON receives at most one repair attempt and must then pass Ajv validation. The healer queue permits one active request with a bounded waiting queue.

LM Studio and Ollama endpoints must use HTTP(S) on loopback. Remote model endpoints are rejected. Auto mode probes local defaults; the model only selects controller-created candidate IDs.

A full healed profile becomes ready only after structural checks identify one writable composer and one conversation region. Deterministic role labels are preferred hints, but the bounded local healer may choose a controller-enumerated control whose role label is unknown when its DOM structure is compatible with the requested role and it exposes an accessible name or visible text; candidates already identified as a conflicting control type, unlabeled unknown controls, and one candidate assigned to multiple control roles are rejected. Before falling back to synthetic Enter, submission gets one document-scoped attempt to heal an actual Send control. A saved Stop-control locator is used when available to detect external generation and confirm interruption. If Stop exists only during generation, Bachata first tries deterministic discovery and then may select a structurally compatible transient control from the bounded candidate set, persisting the locator only after a verified prompt submission. The same constrained healing applies to a New Conversation control. The bounded healer may also select one controller-enumerated assistant-response candidate. If only response capture fails after a prompt was already submitted, a smaller `bachata-response-heal-v1` decision may repair only the response-message locator and retry capture without resending the prompt.

Response capture anchors to the exact Bachata request nonce and streams later response growth. Automatic completion fails closed unless Bachata observes the provider enter a generation lifecycle and then become idle, followed by a short DOM-quiet confirmation. Text silence by itself is never treated as completion.

## Protocol behavior

A registered generic tab is published as a Protocol v9 session with readiness derived from its validated binding. A visible active Stop control is published as `streaming` even when the generation was started outside Bachata, so a second send cannot be treated as ready. The session identity contains the exact generic conversation URL and document token. Query parameters and fragments are preserved because generic applications may use either as conversation identity.

Each loaded generic document creates a random document token once when its content script starts. Same-document DOM replacement increments the document revision, while a full reload gets a new token even when the URL is unchanged. Before any composer mutation and immediately before the Send/Enter commit, the content script requires the expected document token, document revision, canonical URL, and conversation identity to still match the request selected by the controller.

A generic send is launched asynchronously by the background worker so an interrupt can be processed while response capture is active. A pre-submission interrupt is sticky: it prevents later composer submission even when profile resolution is still in progress. The background publishes `conversation.submitted` only after the content script reports that the provider submission was committed. After submission, cancellation relearns a transient Stop locator when a saved locator is stale, clicks the active Stop control, waits for the live provider generation control to become inactive, and reports `stopConfirmed` only after that observation. Cancellation and provider/capture failures do not count as selector-health failures; only evidence that the saved binding itself is stale increments binding failure state. Same-origin SPA route changes keep the document token while updating conversation identity and session ID; the controller adopts only a same-tab transition that happens after the pre-submit identity checks and submission commit. Cross-origin navigation invalidates the registration. Replacing the live document increments the document revision and requires the response capture path to re-resolve the bound conversation region rather than continuing against detached DOM.

Generic browser transport does not support image attachments or downloadable browser assets. Structured text/code response segments are preserved so managed `bachata-control` and ordinary `bachata-action` code blocks retain their language marker. Managed text/code attachments remain controller-side context and therefore do not depend on generic browser upload support.

## Manual fallback

`Use selected text as response` explicitly terminates the current active generic capture with the selected text without changing the saved profile. It is a human confirmation path, not an automatic completion heuristic. When the selection stays inside one rendered code element, Bachata preserves its detected code language so a selected `bachata-control` block remains executable by the managed controller. Saving an assistant response element as a permanent binding is a separate explicit action.

## Page context

Mozilla Readability extracts article-like specifications and documentation. It is not used for live chat capture. Verified message DOM is converted to Markdown with Turndown and GFM rules while preserving fenced code languages.

## Compatibility boundary

The generic provider supports browser chat applications that expose a visible writable composer, submit behavior, and response text in accessible DOM. Before submission, Bachata reads the composer back and refuses to send if the complete nonce-bearing request was not accepted by the editor.

Closed shadow roots, canvas-only conversations, inaccessible cross-origin frames, and pages that never expose generated text in DOM return an unsupported or manual-binding state instead of guessed managed readiness. Unattended completion requires a detectable generation lifecycle, normally a bound or transiently learned Stop control. When response text appears but no trustworthy generation lifecycle can be observed, Bachata fails the automatic capture after a separate 15-second lifecycle-acquisition deadline rather than waiting for the full model-turn timeout or guessing completion; the user can explicitly finish capture with selected text. Fresh generic provisioning clicks the validated new-conversation control and accepts the result only after route, document, message-count, or substantial content-reset evidence proves that the conversation changed. Provider-specific live smoke remains required for every production target such as Grok or Z.AI.

## Permissions

Generic setup uses `tabs` to identify the selected website, requests optional access for that exact HTTP(S) origin, then injects the setup script with `scripting`. Exact-origin access allows re-injection after refresh or browser restart. Popup removal deletes only the selected unchanged profile and keeps permission. Revoke site access requires confirmation, reports Chrome refusal, and preserves saved profiles. Active requests block management. The legacy clear-profile operation still clears that origin and requests permission removal. The provider remains constrained to origins the user explicitly bound.


## Model selection

The generic adapter selects a bound browser conversation, not the site-specific model control. Choose Grok, Z.AI, or another provider model/mode on the website itself unless a future provider-specific adapter explicitly implements and smoke-tests model selection.
