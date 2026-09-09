# Authenticated provider smoke test

Human-only stable-release gate. Record pass or fail and non-sensitive build identity only. Never record provider content, credentials, tokens, usage, cookies, or screenshots containing private data.

## Build identity

```text
Source archive or commit:
Browser Bridge version:
Chrome version:
Operating system:
Test date:
```

## Setup

- Build the exact recorded source from clean dependencies.
- Load the generated unpacked extension.
- Open one authenticated ChatGPT conversation and one authenticated Claude conversation.
- For every intended generic production target, open an authenticated conversation and bind composer, conversation region, assistant response, send, Stop, and New Conversation controls where available. Test Grok and chat.z.ai explicitly if they are claimed as supported targets.
- Start the matching Protocol v9 endpoint in the recorded Bachata build.

## Popup

Verify:

- endpoint and token drafts survive polling;
- Connect to VS Code requires a token and valid local address; Paste & connect reads only a token from the clipboard;
- connection state and retry controls are accurate;
- Refresh tabs lists both providers; Conversation details reveals tab ID and conversation identity;
- capability summary distinguishes manual completion, unavailable Stop and uncertain conversation state;
- unauthenticated, busy, failed, and not-ready tabs stay listed with their reason and carry no Use this chat control;
- no row carries a Use this chat control until the bridge is paired;
- a ready tab can be bound and remains bound after refresh;
- after binding, the list collapses to the bound conversation and Change conversation reopens it;
- the connection controls stay hidden while connected and open from the status control;
- navigating the bound tab to an unsupported site clears the binding, selected session, and its popup row without leaving a stale error;
- a non-HTTPS or malformed URL using a provider hostname follows the same cleanup path and is never classified as a supported conversation;
- disconnect and re-pair work after a failed endpoint.

## Generic setup and recovery UI

- Use Other websites with keyboard focus and zoom at 320px and the default 380px width.
- Deny site permission: no setup or prompt starts. Grant the displayed origin: setup opens only
  in the selected document. Navigation during setup dispatch must refuse the stale target.
- Auto-detect with the configured local model; test unavailable model and ambiguous controls.
- Choose required controls; cancel a picker; close/reopen setup. A cancelled picker must not
  capture a later page click. Missing optional controls keep manual limitations.
- Verify picker outline during hover, scroll and resize. Use arrows to choose a nonfocusable
  conversation region; Enter saves without activating Send. Escape cancels; focus returns to
  the setup control. Repeat at zoom with a screen reader.
- Validate, bind, reopen the popup. Capabilities must match observed session evidence.
- Inspect multiple saved bindings. Remove one; preserve others and site permission. Change a
  profile before confirming removal: stale removal must fail.
- Cancel and confirm site-access revocation. Browser refusal stays visible; saved profiles stay.
  An active request must block management. Regrant and repair from the current page.
- Fail submission, capture and Stop separately. Show only recorded facts; recovery never
  resends. Select a completed Generic response during an active manual request. It must complete
  that request, preserve the answer, and disclose that selection may stop generation.
- Change conversation during selected-response recovery. No foreign Stop click or answer
  acceptance. Inspect the existing conversation through the failure's Open conversation action.

## Alarm-backed reconnect after worker shutdown

Run this against the exact release build in Chrome, not a mocked extension environment.

1. Pair Browser Bridge and confirm the endpoint is connected.
2. Stop the Bachata Protocol v9 endpoint without opening the popup again.
3. Keep the endpoint unavailable until the reconnect schedule reaches a delay longer than 30 seconds. Record the disconnect time and the persisted next-attempt time from the extension service-worker inspection page.
4. Close extension DevTools and leave the browser idle long enough for Chrome to terminate the background service worker. Confirm the worker is inactive from `chrome://extensions` without starting it.
5. Restore the same Bachata endpoint before the persisted alarm time. Do not open the popup, inspect a provider tab, reload the extension, or click the service-worker link.
6. After the alarm time, confirm the worker restarted and the bridge reconnected automatically. Record the alarm time, worker restart time, and connection time.
7. Stop the endpoint again, let the alarm fire while it is unavailable, then restore the endpoint and confirm the next alarm-backed attempt reconnects without user interaction.
8. Restart Chrome while a reconnect is pending and confirm startup restores the persisted retry schedule and reconnects without opening the popup.

Fail the release gate if reconnect requires any manual wakeup, if the persisted schedule disappears, if duplicate alarms are created, or if retries continue after a successful connection.

Record:

```text
Long retry reached: PASS | FAIL
Worker became inactive: PASS | FAIL
Alarm restarted worker: PASS | FAIL
Reconnected without popup: PASS | FAIL
Retry after missed alarm: PASS | FAIL
Chrome restart recovery: PASS | FAIL
Disconnect time:
Persisted alarm time:
Worker restart time:
Connection time:
```

## ChatGPT

Verify:

- exact conversation binding;
- prompt insertion and submission;
- pre-existing composer text or attachments block submission;
- a forced pre-submit failure clears staged text and attachments or marks the tab failed until reload;
- unrelated page-wide Upload, Attach, Send, and Stop controls are ignored;
- streaming and final rendered response capture;
- code blocks, links, and visible downloadable assets;
- interrupt during generation;
- deliberately break or invalidate Stop discovery while generation is active and confirm interruption fails instead of reporting success;
- after an unconfirmed capture or interruption, confirm the exact conversation is quarantined across refresh and cannot accept another automatic send;
- a successfully captured/confirmed-stop conversation is not quarantined, while opening a fresh conversation uses a new confirmed identity;
- SPA navigation invalidates stale binding and re-registers the new conversation.

## Claude

Repeat the same checks for Claude, including visible artifact capture without unrelated controls or old artifact panes. Repeat the broken-Stop and quarantine checks independently for Claude.

## Generic browser targets

Run this section separately for every production generic target. Do not mark a site supported from mocked DOM tests alone.

Verify:

- binding requests host permission only for the selected origin and a validated profile survives page refresh;
- a full browser restart with the target tab restored reconstructs the registration without opening the popup;
- two bound generic providers, such as Grok and Z.AI, remain independently selectable and do not fall into an ambiguous global Generic pool;
- fresh provisioning selects the same bound provider identity, activates its validated New Conversation control, observes fresh-conversation evidence, and opens a usable fresh conversation;
- streamed output appears before the final response;
- rendered fenced code preserves the exact language marker, including `bachata-control` and `bachata-action`;
- a response exceeding three minutes completes when the controller deadline is longer;
- a deliberate visible-output pause longer than ten seconds does not complete the turn early;
- a Stop control that appears more than three seconds after submission is still learned and used as generation lifecycle evidence;
- when no trustworthy generation lifecycle exists, automatic completion fails closed rather than accepting text silence;
- `Use selected text as response` explicitly completes an active capture when manual confirmation is required; if provider idle cannot be positively confirmed, the conversation becomes quarantined instead of ready;
- a manual profile validation does not clear an uncertain conversation; a confirmed fresh conversation does;
- response-selector healing after the provider already became idle captures the existing response without resending the prompt or resetting lifecycle evidence;
- a provider that renders status/reasoning and final answer as separate assistant siblings returns the final assistant segment for the nonce-bound turn;
- interrupt before submission prevents later submission and interrupt after submission confirms provider idle before reporting success;
- SPA navigation, refresh, and response DOM replacement do not attach the result to the wrong request;
- managed Worker responses containing `bachata-control` survive browser DOM capture, Protocol v9 transport, and VS Code parsing;
- Lead read-only policy rejects mutation requests;
- the site-specific internal model is selected on the website because the generic adapter does not change provider model controls.

Record target-specific results:

```text
Generic target name:
Origin:
Browser/site model selected:
Binding/restart recovery: PASS | FAIL
Streaming: PASS | FAIL
Long response: PASS | FAIL
Long pause safety: PASS | FAIL
Managed bachata-control: PASS | FAIL
Response-heal without resend: PASS | FAIL
Multi-segment final answer: PASS | FAIL
Quarantine/recovery: PASS | FAIL
Interrupt: PASS | FAIL
Fresh provisioning: PASS | FAIL
```

## Provisioning

Verify open, queued cancellation, active cancellation, and failed-tab diagnostics.

## Result

```text
Popup: PASS | FAIL
ChatGPT: PASS | FAIL
Claude: PASS | FAIL
Generic targets: PASS | FAIL
Grok via Generic: PASS | FAIL | NOT CLAIMED
Z.AI via Generic: PASS | FAIL | NOT CLAIMED
Provisioning: PASS | FAIL
Reconnect: PASS | FAIL
```
