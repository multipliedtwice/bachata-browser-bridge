export type GenericFreshnessObservation = {
  beforeUrl: string;
  currentUrl: string;
  beforeRevision: number;
  currentRevision: number;
  beforeMessageCount: number;
  currentMessageCount: number;
  beforeTextLength: number;
  currentTextLength: number;
  explicitResetRequested?: boolean;
};

export const genericFreshnessStabilityMs = 2_500;
export const genericInitialEmptyStabilityMs = 5_000;

export const genericFreshnessObserved = (observation: GenericFreshnessObservation): boolean => {
  const messageReset = observation.beforeMessageCount > 0
    && observation.currentMessageCount === 0;
  const textReset = observation.beforeTextLength >= 200
    && observation.currentTextLength <= Math.floor(observation.beforeTextLength * 0.35);
  const blankReset = (observation.beforeMessageCount > 0 || observation.beforeTextLength > 0)
    && observation.currentMessageCount === 0
    && observation.currentTextLength === 0;
  const documentChanged = observation.currentUrl !== observation.beforeUrl
    || observation.currentRevision !== observation.beforeRevision;
  // BR-G6-07. Asking for a reset raises the bar; it does not lower it. When the conversation
  // being left had turns in it, a changed URL, a bumped revision and a new document token are
  // all churn on their own — a re-render the message selector stopped matching, or a document
  // replaced in place with the same conversation still underneath, both read as "no messages"
  // for as long as they take to settle. What attests a reset is that the conversation which was
  // there is demonstrably gone: no turns, and its text either gone or collapsed. A page that had
  // no turns to lose keeps the weaker rule, because it has nothing that could be mistaken for a
  // fresh conversation.
  const previousConversationWithdrawn = observation.beforeMessageCount === 0
    || observation.currentTextLength === 0
    || textReset;
  const explicitDocumentReset = observation.explicitResetRequested === true
    && documentChanged
    && observation.currentMessageCount === 0
    && previousConversationWithdrawn
    && (observation.currentUrl !== observation.beforeUrl
      || observation.beforeMessageCount > 0
      || observation.beforeTextLength > 0);
  return (messageReset && (textReset || observation.currentTextLength === 0))
    || (textReset && observation.currentMessageCount < observation.beforeMessageCount)
    || (documentChanged && blankReset)
    || explicitDocumentReset;
};

export const genericEmptyConversationStable = (input: {
  documentReady: boolean;
  generationActive: boolean;
  messageCount: number;
  textLength: number;
  stableForMs: number;
}): boolean => Boolean(
  input.documentReady
  && !input.generationActive
  && input.messageCount === 0
  && input.textLength === 0
  && input.stableForMs >= genericInitialEmptyStabilityMs
);
