type BachataOwnedFaviconController = {
  ensure: () => void;
  restore: () => void;
};

type BachataOwnedWindow = Window & {
  __BACHATA_OWNED_FAVICON__?: BachataOwnedFaviconController;
};

const bachataOwnedWindow = window as BachataOwnedWindow;
const existingOwnedFavicon = bachataOwnedWindow.__BACHATA_OWNED_FAVICON__;
const ownedFaviconHref = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="white"/><path d="M8.75 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11M15.25 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11" fill="none" stroke="#299e68" stroke-width="2"/></svg>',
)}`;

if (existingOwnedFavicon) {
  existingOwnedFavicon.ensure();
} else {
  const marker = document.createElement("link");
  marker.setAttribute("data-bachata-owned-favicon", "true");
  const displacedIcons = new Set<HTMLLinkElement>();

  const ensure = (): void => {
    const head = document.head;
    if (!head) return;
    for (const icon of head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
      if (icon === marker) continue;
      displacedIcons.add(icon);
      icon.parentNode?.removeChild(icon);
    }
    if (marker.rel !== "icon") marker.rel = "icon";
    if (marker.type !== "image/svg+xml") marker.type = "image/svg+xml";
    if (marker.getAttribute("href") !== ownedFaviconHref) {
      marker.setAttribute("href", ownedFaviconHref);
    }
    if (marker.parentNode !== head) head.appendChild(marker);
  };
  const observer = new MutationObserver(ensure);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "rel"],
  });
  const release = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: chrome.runtime.SendResponse,
  ): void => {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || (message as Record<string, unknown>).type !== "bachata.ownership.release") {
      return;
    }
    controller.restore();
    sendResponse({ success: true });
  };
  const controller: BachataOwnedFaviconController = {
    ensure,
    restore: () => {
      observer.disconnect();
      chrome.runtime.onMessage.removeListener(release);
      marker.parentNode?.removeChild(marker);
      const head = document.head;
      if (head) {
        for (const icon of displacedIcons) {
          if (!icon.parentNode) head.appendChild(icon);
        }
      }
      displacedIcons.clear();
      delete bachataOwnedWindow.__BACHATA_OWNED_FAVICON__;
    },
  };
  bachataOwnedWindow.__BACHATA_OWNED_FAVICON__ = controller;
  chrome.runtime.onMessage.addListener(release);
  ensure();
}
