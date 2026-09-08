import { jsonrepair } from "jsonrepair";
import { createSchemaValidator } from "./schemaGuard.js";
import type { DomCandidate, GenericBindingRole } from "./types.js";

export type DomHealingDecision = {
  protocol: "bachata-dom-heal-v1";
  status: "selected" | "ambiguous" | "unsupported";
  composerIds: string[];
  conversationRootIds: string[];
  sendButtonIds: string[];
  stopButtonIds: string[];
  newConversationButtonIds: string[];
  responseMessageIds: string[];
};

export type ResponseHealingDecision = {
  protocol: "bachata-response-heal-v1";
  status: "selected" | "ambiguous" | "unsupported";
  responseMessageIds: string[];
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "status", "composerIds", "conversationRootIds", "sendButtonIds", "stopButtonIds", "responseMessageIds"],
  properties: {
    protocol: { const: "bachata-dom-heal-v1" },
    status: { enum: ["selected", "ambiguous", "unsupported"] },
    composerIds: { type: "array", maxItems: 2, items: { type: "string" } },
    conversationRootIds: { type: "array", maxItems: 2, items: { type: "string" } },
    sendButtonIds: { type: "array", maxItems: 2, items: { type: "string" } },
    stopButtonIds: { type: "array", maxItems: 2, items: { type: "string" } },
    newConversationButtonIds: { type: "array", maxItems: 2, items: { type: "string" } },
    responseMessageIds: { type: "array", maxItems: 1, items: { type: "string" } },
  },
} as const;

const validate = createSchemaValidator(schema);

export const DOM_HEALING_CANDIDATE_LIMIT = 24;
export const RESPONSE_HEALING_CANDIDATE_LIMIT = 16;

const candidateMatchesRole = (
  candidate: DomCandidate | undefined,
  role: GenericBindingRole,
): boolean => {
  if (!candidate) return false;
  const buttonLike = candidate.tag === "button" || candidate.role === "button";
  if (role === "composer") {
    return candidate.kindHint === "composer"
      || candidate.contentEditable
      || candidate.tag === "textarea"
      || candidate.tag === "input"
      || candidate.role === "textbox";
  }
  if (role === "conversationRoot") {
    return candidate.kindHint === "conversationRoot"
      || candidate.tag === "main"
      || candidate.role === "main"
      || candidate.role === "feed"
      || candidate.role === "log"
      || candidate.role === "region";
  }
  if (role === "sendButton" || role === "stopButton" || role === "newConversationButton") {
    const interpretableUnknown = candidate.kindHint === "unknown"
      && Boolean(candidate.accessibleName?.trim() || candidate.textPreview?.trim());
    return buttonLike && (candidate.kindHint === role || interpretableUnknown);
  }
  if (role === "responseMessage") {
    return candidate.kindHint === "message"
      || candidate.kindHint === "responseMessage"
      || candidate.tag === "article"
      || candidate.role === "article"
      || (candidate.kindHint === "unknown" && !buttonLike && Boolean(candidate.textPreview?.trim()));
  }
  return false;
};

const idsMatchRole = (
  ids: readonly string[],
  role: GenericBindingRole,
  candidates: ReadonlyMap<string, DomCandidate>,
): boolean => ids.every((id) => candidateMatchesRole(candidates.get(id), role));

export function buildHealingPrompt(candidates: DomCandidate[]): string {
  return JSON.stringify({
    protocol: "bachata-dom-heal-v1",
    instruction: "Select only supplied candidate IDs. Never return CSS, XPath, JavaScript, URLs, coordinates, or new IDs. Return ambiguous when uncertain.",
    candidates: candidates.slice(0, DOM_HEALING_CANDIDATE_LIMIT),
    output: {
      protocol: "bachata-dom-heal-v1",
      status: "selected | ambiguous | unsupported",
      composerIds: [],
      conversationRootIds: [],
      sendButtonIds: [],
      stopButtonIds: [],
      newConversationButtonIds: [],
      responseMessageIds: [],
    },
  });
}

export function parseHealingDecision(text: string, candidates: DomCandidate[]): DomHealingDecision {
  const attempts = [text];
  // BB-AUD-10. The repaired form is an extra attempt, never a required one: text the
  // repairer cannot handle leaves the model's own output as the only candidate.
  try { attempts.push(jsonrepair(text)); } catch {
    // Only the original text is attempted.
  }
  const bounded = candidates.slice(0, DOM_HEALING_CANDIDATE_LIMIT);
  const byId = new Map(bounded.map((candidate) => [candidate.id, candidate]));
  const allowed = new Set(byId.keys());
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (!validate(parsed)) continue;
      const parsedDecision = parsed as Omit<DomHealingDecision, "newConversationButtonIds"> & { newConversationButtonIds?: string[] };
      const decision: DomHealingDecision = {
        ...parsedDecision,
        newConversationButtonIds: parsedDecision.newConversationButtonIds ?? [],
      };
      const ids = [...decision.composerIds, ...decision.conversationRootIds, ...decision.sendButtonIds, ...decision.stopButtonIds, ...decision.newConversationButtonIds, ...decision.responseMessageIds];
      if (ids.some((id) => !allowed.has(id)) || new Set(ids).size !== ids.length) continue;
      if (!idsMatchRole(decision.composerIds, "composer", byId)
        || !idsMatchRole(decision.conversationRootIds, "conversationRoot", byId)
        || !idsMatchRole(decision.sendButtonIds, "sendButton", byId)
        || !idsMatchRole(decision.stopButtonIds, "stopButton", byId)
        || !idsMatchRole(decision.newConversationButtonIds, "newConversationButton", byId)
        || !idsMatchRole(decision.responseMessageIds, "responseMessage", byId)) {
        continue;
      }
      if (decision.status === "selected"
        && (decision.composerIds.length !== 1
          || decision.conversationRootIds.length !== 1
          || decision.sendButtonIds.length > 1
          || decision.stopButtonIds.length > 1
          || decision.newConversationButtonIds.length > 1)) {
        continue;
      }
      return decision;
    } catch {
      // BB-AUD-10. An attempt that will not parse is not a decision. The ambiguous verdict
      // below is the answer when no attempt produces one, which fails closed.
    }
  }
  return {
    protocol: "bachata-dom-heal-v1",
    status: "ambiguous",
    composerIds: [],
    conversationRootIds: [],
    sendButtonIds: [],
    stopButtonIds: [],
    newConversationButtonIds: [],
    responseMessageIds: [],
  };
}


const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["protocol", "status", "responseMessageIds"],
  properties: {
    protocol: { const: "bachata-response-heal-v1" },
    status: { enum: ["selected", "ambiguous", "unsupported"] },
    responseMessageIds: { type: "array", maxItems: 1, items: { type: "string" } },
  },
} as const;

const validateResponse = createSchemaValidator(responseSchema);

export function buildResponseHealingPrompt(candidates: DomCandidate[]): string {
  return JSON.stringify({
    protocol: "bachata-response-heal-v1",
    instruction: "Select the supplied candidate that represents an assistant/model response message. Return only a supplied candidate ID. Never return CSS, XPath, JavaScript, URLs, coordinates, or new IDs. Return ambiguous when uncertain.",
    candidates: candidates.slice(0, RESPONSE_HEALING_CANDIDATE_LIMIT),
    output: {
      protocol: "bachata-response-heal-v1",
      status: "selected | ambiguous | unsupported",
      responseMessageIds: [],
    },
  });
}

export function parseResponseHealingDecision(text: string, candidates: DomCandidate[]): ResponseHealingDecision {
  const attempts = [text];
  // BB-AUD-10, as above: the repaired form is an extra attempt, never a required one.
  try { attempts.push(jsonrepair(text)); } catch {
    // Only the original text is attempted.
  }
  const bounded = candidates.slice(0, RESPONSE_HEALING_CANDIDATE_LIMIT);
  const byId = new Map(bounded.map((candidate) => [candidate.id, candidate]));
  const allowed = new Set(byId.keys());
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (!validateResponse(parsed)) continue;
      const decision = parsed as ResponseHealingDecision;
      if (decision.responseMessageIds.some((id) => !allowed.has(id))) continue;
      if (!idsMatchRole(decision.responseMessageIds, "responseMessage", byId)) continue;
      if (decision.status === "selected" && decision.responseMessageIds.length !== 1) continue;
      return decision;
    } catch {
      // BB-AUD-10. As above: no parsed attempt means the ambiguous verdict below.
    }
  }
  return {
    protocol: "bachata-response-heal-v1",
    status: "ambiguous",
    responseMessageIds: [],
  };
}
