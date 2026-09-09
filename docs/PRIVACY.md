# Privacy

The Bachata Browser Bridge connects chat websites to workflows in the Bachata VS Code extension. It processes the information needed to send your workflow messages to a connected chat and return the result. It sends no telemetry; [NO_TELEMETRY.md](../NO_TELEMETRY.md) states that policy.

Chat prompts and replies are personal communications. They may include project information or other personal information you supply through Bachata. The Bridge receives prompts and supported image attachments from the paired local VS Code extension and submits them to the chat website you choose. It reads rendered replies and supported response assets from that website and returns them to the paired local extension. A requested page-content extraction or manual response selection also reads website content for the connected workflow. Generic website connections support text, not image attachments.

The Bridge reads supported or explicitly bound tabs' URLs, titles, and conversation identifiers to list available chats, identify the selected conversation, and avoid sending messages to a different conversation after navigation. Conversation information is also shared with the paired local VS Code extension for those operations.

Extension-local storage may contain the local connection address, persistent connection token, selected and handled tab/session identifiers, reconnect schedule, saved website binding profiles and drafts, and session-scoped website registrations. Binding configuration can include a website origin, route pattern, and descriptions of selected page elements, such as labels and selectors. These records let the Bridge reconnect and find the controls you configured. The Bachata endpoint binds the persistent connection token to the exact Chrome extension origin during pairing; the token authenticates the local connection.

The Bridge does not store a permanent prompt or response archive. It holds message and asset data as needed to process requests. This does not describe retention by the chat website or the companion VS Code extension: the chosen provider processes submitted messages and attachments under its own privacy policy, and the local Bachata extension receives workflow results. Review the chosen provider's policy before sending sensitive information.

When you choose to set up another website, the Bridge requests access to that website's exact origin. Its control picker temporarily handles mouse movement, clicks, and the arrow, Enter, and Escape keys to highlight, choose, or cancel a page-element selection. It does not record a history of those interactions. The picker removes its event handlers when selection finishes, is cancelled, or expires; the selected element's configuration may be saved locally as described above. These interactions serve setup, not analytics.

If you explicitly configure local-model assistance, the Bridge can send bounded descriptions of page elements, including labels and text previews that may contain conversation content, to your configured local LM Studio or Ollama endpoint. This helps identify website controls and responses. The endpoint is restricted to your own computer; its handling of those requests depends on your local model application and configuration.

Extension-initiated network traffic is limited to the configured loopback WebSocket endpoint, an explicitly configured loopback LM Studio or Ollama selector-healing endpoint, ChatGPT and Claude navigation opened by the user or provisioning, and explicit built-in-provider asset fetches inside the authenticated browser context. Generic providers are manipulated through the DOM only after exact-origin access is granted.

The popup renders provider icons from Chrome's local favicon cache through the `favicon` permission. That path reads what Chrome already stored and issues no network request; a missing entry falls back to a drawn monogram.

The `webNavigation` permission reports that a bound tab navigated — the tab, the frame, the document identity and the URL — and nothing about page content. Nothing from it is stored: it is read, matched against the bound conversation, and discarded. It replaced a permanent poll of the page's own URL.

The `clipboardRead` permission is used only when the user presses Paste or Paste & Pair in the popup. The clipboard value is read once into the popup's in-memory pairing draft, is never written to extension storage, and is discarded when pairing succeeds or the popup closes. Successful pairing exchanges the short-lived pairing token for the persistent connection token described above.

No analytics, usage metrics, crash reports, remote logs, fingerprints, or install IDs are sent.
