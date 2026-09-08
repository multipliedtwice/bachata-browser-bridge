export const genericLifecycleAcquisitionTimeoutMs = 15_000;
export const genericCompletionQuietMs = 2_500;

export const genericLifecycleAcquisitionExpired = (input: {
  responseObservedAt?: number | undefined;
  now: number;
  sawGeneration: boolean;
  timeoutMs?: number | undefined;
}): boolean => Boolean(
  input.responseObservedAt !== undefined
  && !input.sawGeneration
  && input.now - input.responseObservedAt >= (input.timeoutMs ?? genericLifecycleAcquisitionTimeoutMs)
);

export const genericResponseCompletionConfirmed = (input: {
  generationObserverAvailable: boolean;
  sawGeneration: boolean;
  generating: boolean;
  generationEndedAt?: number | undefined;
  stableSince: number;
  now: number;
}): boolean => Boolean(
  input.generationObserverAvailable
  && input.sawGeneration
  && !input.generating
  && input.generationEndedAt !== undefined
  && input.now - input.generationEndedAt >= genericCompletionQuietMs
  && input.now - input.stableSince >= genericCompletionQuietMs
);
