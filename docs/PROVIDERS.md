# Provider adapters

Built-in adapter origins:

```text
https://chatgpt.com/*
https://claude.ai/*
```

## Shared rules

- Top frame only.
- Exact origin check.
- One document token per page document.
- One stable conversation identity.
- One live request per session.
- Visible composer and send control only.
- No login or CAPTCHA automation.
- No hidden prompt prefix.
- Rendered-text capture is best effort.
- The provider composer must be empty before a bridge request.
- A failed pre-submit attempt clears staged text and attachments.
- If cleanup cannot be verified, the tab reports a failed state and rejects further requests until the page is reloaded.

## ChatGPT

The content script handles:

- SPA navigation;
- composer discovery;
- image attachment;
- prompt submission;
- streaming response replacement;
- stop control;
- visible generated assets.

### Alert taxonomy

The ChatGPT adapter classifies provider alerts before deciding a turn failed. Two conditions must
hold together: the alert sits in a root the adapter already owns, and its text matches one class
only.

Owned roots and the classes each admits:

| Root | Scope | Classes |
| --- | --- | --- |
| The bound response element | `response` | `response_failed`, `rate_limited` |
| The composer's own `form`, with files staged | `attachment` | `attachment_rejected` |
| The composer's own `form` | `composer` | `rate_limited`, `attachment_rejected` |
| A `[role="dialog"]` modal | `dialog` | `rate_limited`, `session_expired`, `subscription_unavailable` |

Rules:

- A `[role="alert"]` outside those roots is ignored. It never ends a turn.
- An alert whose text matches two classes is dropped, not guessed.
- Unknown or localized wording produces no class, and the turn follows its normal timing.
- A previous response's alert is out of scope: only the bound response is read.

Classified failures travel to the controller as `conversation.error` codes, with the provider's
own words as the message:

```text
PROVIDER_RATE_LIMITED
PROVIDER_SESSION_EXPIRED
PROVIDER_SUBSCRIPTION_UNAVAILABLE
PROVIDER_RESPONSE_FAILED
PROVIDER_ATTACHMENT_REJECTED
```

An unclassified refusal keeps the existing `SUBMISSION_FAILED` or `RESPONSE_CAPTURE_FAILED` code.
Claude has no taxonomy: its alerts say different things in different places, and no measurement of
them exists yet.

## Claude

The content script handles:

- SPA navigation;
- composer discovery;
- image attachment;
- prompt submission;
- streaming response replacement;
- stop control;
- visible files and safely serializable artifact panes.

Interactive artifacts are not executed.

## Readiness

Session states:

- disconnected;
- not authenticated;
- not ready;
- ready;
- submitting;
- streaming;
- failed.

A provider tab without a valid registered document is shown as not inspected.

The popup lists every discovered tab with its own status, and listing never changes the current binding. Only a `ready` row carries a bind action at all, and only while the bridge is paired. Stop using is offered only on the selected row. Once a conversation is bound the list collapses to that conversation until Change conversation is selected. Provisioning succeeds only after a matching session reports `ready`.

Generic page-wide Attach and Upload controls are ignored. Attachment controls and inputs must belong to the active composer. ChatGPT may additionally use its exact `composer-button-file-upload` control when the provider renders that control outside the form. Claude Send and Stop controls must belong to the active composer region. Ambiguous or unrelated controls are rejected without modification.

## Identity

Each popup row shows provider, title, completion support and current limitations. Conversation details holds tab ID, remaining capabilities and the stable conversation identity when registered. The host is shown only when it differs from the provider's own host, so an unexpected host is visible instead of buried in repetition; the host and path are available as a tooltip. Title alone is never authoritative.

## Known limit

Provider DOM and controls are unofficial integration points. Every release needs live authenticated smoke tests.

## Maintenance contract

Generic Browser is the primary maintained browser abstraction. New lifecycle work lands
there first, and its behaviour is what the Bridge guarantees.

The ChatGPT and Claude DOM integrations stay in the product. They are not deleted for want of
evidence. Stable compatibility is claimed only for an exact build with recorded results from
`docs/LIVE_SMOKE_TEST.md`; untested provider/build combinations remain experimental.

Conversation URL recognition, canonical identity, session identity, and initial-transition
rules are provider-specific. `tests/conversationIdentity.test.mjs` covers that isolation.
