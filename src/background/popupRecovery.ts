import type { ActiveRequest } from "./routerState.js";

export type PopupRecovery = {
  kind: "failure" | "capture" | "binding" | "stopUnconfirmed" | "stopped";
  submission: "prevented" | "committed" | "uncertain";
};

export const isPopupRecovery = (value: unknown): value is PopupRecovery =>
  Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => key === "kind" || key === "submission")
    && "kind" in value && typeof value.kind === "string"
    && ["failure", "capture", "binding", "stopUnconfirmed", "stopped"].includes(value.kind)
    && "submission" in value && typeof value.submission === "string"
    && ["prevented", "committed", "uncertain"].includes(value.submission));

export const recoveryForRequest = (request: Pick<ActiveRequest, "submissionAttempted" | "submissionCommitted">, kind: PopupRecovery["kind"]): PopupRecovery => ({
  kind,
  submission: request.submissionCommitted ? "committed" : request.submissionAttempted ? "uncertain" : "prevented",
});

export const popupRecoveryDescription = (recovery: PopupRecovery): string => {
  const submission = recovery.submission === "prevented" ? "Prompt was not submitted."
    : recovery.submission === "committed" ? "Prompt was submitted." : "Prompt submission is uncertain.";
  const detail = recovery.kind === "stopUnconfirmed" ? "Stop was not confirmed; generation may still be running."
    : recovery.kind === "stopped" ? "The request was interrupted."
      : recovery.kind === "capture" ? "Final answer capture failed. Inspect the existing answer on the website."
        : recovery.kind === "binding" ? "The conversation binding changed. Inspect the website before binding again."
          : "Inspect the conversation before continuing.";
  return `${recovery.kind === "binding" ? "Previous request: " : ""}${submission} ${detail} No prompt will be resent by this action.`;
};

export const createPopupRecoveryStore = () => {
  const entries = new Map<number, { requestId: string; documentToken: string; conversationIdentity: string; recovery: PopupRecovery }>();
  return {
    remember(request: ActiveRequest, kind: PopupRecovery["kind"]): void {
      entries.delete(request.tabId);
      entries.set(request.tabId, {
        requestId: request.requestId, documentToken: request.documentToken,
        conversationIdentity: request.conversationIdentity, recovery: recoveryForRequest(request, kind),
      });
      if (entries.size > 200) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    clear(tabId: number, requestId?: string): void {
      if (requestId === undefined || entries.get(tabId)?.requestId === requestId) entries.delete(tabId);
    },
    get(tabId: number, binding?: { documentToken: string; conversationIdentity: string }): PopupRecovery | undefined {
      const entry = entries.get(tabId);
      if (!entry) return undefined;
      if (!binding || entry.documentToken !== binding.documentToken || entry.conversationIdentity !== binding.conversationIdentity) {
        return { ...entry.recovery, kind: "binding" };
      }
      return { ...entry.recovery };
    },
  };
};
