import { DOM_HEALING_CANDIDATE_LIMIT, RESPONSE_HEALING_CANDIDATE_LIMIT, buildHealingPrompt, buildResponseHealingPrompt, parseHealingDecision, parseResponseHealingDecision } from "./healing.js";
import type { DomHealingDecision, ResponseHealingDecision } from "./healing.js";
import type { DomCandidate } from "./types.js";

const requestLocalModel = async (prompt: string, deadlineAt?: number): Promise<string> => {
  const requestId = crypto.randomUUID();
  const cancel = (): void => { void chrome.runtime.sendMessage({ type: "BACHATA_LOCAL_MODEL_CANCEL", requestId }).catch(() => undefined); };
  addEventListener("pagehide", cancel, { once: true });
  try {
    const response = await chrome.runtime.sendMessage({
      type: "BACHATA_LOCAL_MODEL_PROMPT",
      requestId,
      prompt,
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    }) as Record<string, unknown> | undefined;
    if (!response || response.ok !== true || typeof response.text !== "string") {
      throw new Error(typeof response?.error === "string" ? response.error : "Local model selector-healing request failed");
    }
    return response.text;
  } finally {
    removeEventListener("pagehide", cancel);
  }
};

export const healWithLocalModel = async (
  candidates: readonly DomCandidate[],
  deadlineAt?: number,
): Promise<DomHealingDecision> => {
  const bounded = [...candidates].slice(0, DOM_HEALING_CANDIDATE_LIMIT);
  const prompt = buildHealingPrompt(bounded);
  const text = await requestLocalModel(prompt, deadlineAt);
  return parseHealingDecision(text, bounded);
};


export const healResponseWithLocalModel = async (
  candidates: readonly DomCandidate[],
  deadlineAt?: number,
): Promise<ResponseHealingDecision> => {
  const bounded = [...candidates]
    .filter((candidate) => candidate.kindHint === "message" || Boolean(candidate.textPreview))
    .sort((left, right) => Number(right.kindHint === "message") - Number(left.kindHint === "message"))
    .slice(0, RESPONSE_HEALING_CANDIDATE_LIMIT);
  if (bounded.length === 0) {
    return { protocol: "bachata-response-heal-v1", status: "unsupported", responseMessageIds: [] };
  }
  const prompt = buildResponseHealingPrompt(bounded);
  const text = await requestLocalModel(prompt, deadlineAt);
  return parseResponseHealingDecision(text, bounded);
};
