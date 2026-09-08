export type GenericCapturedSegment = {
  type: "text" | "codeBlock" | "quote";
  text: string;
  start: number;
  end: number;
  language?: string | undefined;
};

export type GenericBindingRole = "composer" | "conversationRoot" | "sendButton" | "stopButton" | "newConversationButton" | "responseMessage";
export type GenericBindingSource = "builtIn" | "user" | "autoHeal";

export type LocatorRecipe = {
  tag?: string | undefined;
  role?: string | undefined;
  accessibleName?: string | undefined;
  placeholder?: string | undefined;
  stableAttributes: Record<string, string>;
  cssFallback?: string | undefined;
  structuralPath: number[];
};

export type GenericBindingProfile = {
  protocol: "bachata-generic-binding-v1";
  origin: string;
  routePattern?: string | undefined;
  framePath: string[];
  composer: LocatorRecipe;
  conversationRoot: LocatorRecipe;
  sendButton?: LocatorRecipe | undefined;
  stopButton?: LocatorRecipe | undefined;
  newConversationButton?: LocatorRecipe | undefined;
  responseMessage?: LocatorRecipe | undefined;
  createdBy: GenericBindingSource;
  bindingSources?: Partial<Record<GenericBindingRole, GenericBindingSource>> | undefined;
  validated: boolean;
  lastSuccessfulAt?: string | undefined;
  consecutiveFailures: number;
  documentRevision: number;
  stopControlObservedAt?: string | undefined;
  stopControlFingerprint?: string | undefined;
  stopControlRoutePattern?: string | undefined;
  lifecycleCompletedAt?: string | undefined;
  lifecycleCompletedFingerprint?: string | undefined;
  lifecycleCompletedRoutePattern?: string | undefined;
  interruptionConfirmedAt?: string | undefined;
  interruptionConfirmedFingerprint?: string | undefined;
  interruptionConfirmedRoutePattern?: string | undefined;
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
  Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");

export const isLocatorRecipe = (value: unknown): value is LocatorRecipe => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recipe = value as Record<string, unknown>;
  return (recipe.tag === undefined || typeof recipe.tag === "string")
    && (recipe.role === undefined || typeof recipe.role === "string")
    && (recipe.accessibleName === undefined || typeof recipe.accessibleName === "string")
    && (recipe.placeholder === undefined || typeof recipe.placeholder === "string")
    && isStringRecord(recipe.stableAttributes)
    && (recipe.cssFallback === undefined || typeof recipe.cssFallback === "string")
    && Array.isArray(recipe.structuralPath)
    && recipe.structuralPath.every((entry) => Number.isInteger(entry) && Number(entry) >= 0);
};

const bindingRoles = new Set<GenericBindingRole>([
  "composer",
  "conversationRoot",
  "sendButton",
  "stopButton",
  "newConversationButton",
  "responseMessage",
]);

const bindingSources = new Set<GenericBindingSource>(["builtIn", "user", "autoHeal"]);

const isBindingSources = (value: unknown): value is Partial<Record<GenericBindingRole, GenericBindingSource>> => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([role, source]) =>
    bindingRoles.has(role as GenericBindingRole) && bindingSources.has(source as GenericBindingSource));
};

export const isGenericBindingProfile = (value: unknown, origin?: string): value is GenericBindingProfile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return profile.protocol === "bachata-generic-binding-v1"
    && typeof profile.origin === "string"
    && (!origin || profile.origin === origin)
    && (profile.routePattern === undefined || typeof profile.routePattern === "string")
    && Array.isArray(profile.framePath)
    && profile.framePath.every((entry) => typeof entry === "string")
    && isLocatorRecipe(profile.composer)
    && isLocatorRecipe(profile.conversationRoot)
    && (profile.sendButton === undefined || isLocatorRecipe(profile.sendButton))
    && (profile.stopButton === undefined || isLocatorRecipe(profile.stopButton))
    && (profile.newConversationButton === undefined || isLocatorRecipe(profile.newConversationButton))
    && (profile.responseMessage === undefined || isLocatorRecipe(profile.responseMessage))
    && bindingSources.has(profile.createdBy as GenericBindingSource)
    && isBindingSources(profile.bindingSources)
    && typeof profile.validated === "boolean"
    && (profile.lastSuccessfulAt === undefined || typeof profile.lastSuccessfulAt === "string")
    && Number.isInteger(profile.consecutiveFailures)
    && Number(profile.consecutiveFailures) >= 0
    && Number.isInteger(profile.documentRevision)
    && Number(profile.documentRevision) >= 1
    && (profile.stopControlObservedAt === undefined || typeof profile.stopControlObservedAt === "string")
    && (profile.stopControlFingerprint === undefined || typeof profile.stopControlFingerprint === "string")
    && (profile.stopControlRoutePattern === undefined || typeof profile.stopControlRoutePattern === "string")
    && (profile.lifecycleCompletedAt === undefined || typeof profile.lifecycleCompletedAt === "string")
    && (profile.lifecycleCompletedFingerprint === undefined || typeof profile.lifecycleCompletedFingerprint === "string")
    && (profile.lifecycleCompletedRoutePattern === undefined || typeof profile.lifecycleCompletedRoutePattern === "string")
    && (profile.interruptionConfirmedAt === undefined || typeof profile.interruptionConfirmedAt === "string")
    && (profile.interruptionConfirmedFingerprint === undefined || typeof profile.interruptionConfirmedFingerprint === "string")
    && (profile.interruptionConfirmedRoutePattern === undefined || typeof profile.interruptionConfirmedRoutePattern === "string");
};

export type DomCandidate = {
  id: string;
  kindHint: GenericBindingRole | "message" | "unknown";
  tag: string;
  role?: string | undefined;
  accessibleName?: string | undefined;
  placeholder?: string | undefined;
  textPreview?: string | undefined;
  contentEditable: boolean;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
  domOrder: number;
  mutationCount: number;
  textGrowth: number;
};

export type GenericRequest =
  | { type: "BACHATA_GENERIC_BIND"; role: GenericBindingRole }
  | { type: "BACHATA_GENERIC_VALIDATE" }
  | { type: "BACHATA_GENERIC_SETUP" }
  | { type: "BACHATA_GENERIC_STATUS" }
  | { type: "BACHATA_GENERIC_NEW_CONVERSATION" }
  | { type: "BACHATA_GENERIC_SEND"; requestId: string; prompt: string; documentToken: string; documentRevision: number; conversationUrl: string; conversationIdentity: string; deadlineAt: number }
  | { type: "BACHATA_GENERIC_CANCEL"; requestId: string }
  | { type: "BACHATA_GENERIC_CONFIRM_REUSE"; requestId: string; documentToken: string; documentRevision: number; conversationUrl: string; conversationIdentity: string }
  | { type: "BACHATA_GENERIC_SELECTED_TEXT" }
  | { type: "BACHATA_GENERIC_READABLE" }
  | { type: "BACHATA_GENERIC_AUTO_HEAL" };

export type GenericSendResult = {
  markdown: string;
  text: string;
  segments: GenericCapturedSegment[];
  documentToken: string;
  documentRevision: number;
  conversationUrl: string;
  conversationIdentity: string;
  providerIdleConfirmed: boolean;
  completionSource: "verifiedLifecycle" | "manualSelection";
};

export type GenericResponse =
  | { ok: true; value?: unknown }
  | { ok: false; error: string };
