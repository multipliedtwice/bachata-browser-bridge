/**
 * The bookkeeping decisions of an asset transfer.
 *
 * An asset arrives from an untrusted content script one frame at a time, and every frame is
 * judged against the transfer's own running state: started once, sequence in order, size
 * within the budget the controller granted, completion matching what was actually received.
 * Those judgements sat in the service-worker entry beside the socket and `chrome.tabs` calls
 * that act on them, so an out-of-order chunk or an over-budget completion could only be
 * reached by driving a whole capture. The sends and the Chrome calls stay in the entry.
 */

export type AssetTransferState = {
  maxBytes: number;
  receivedBytes: number;
  nextSequence: number;
  started: boolean;
  declaredSize?: number | undefined;
};

export type ParsedAssetStart = {
  name: string;
  mimeType?: string | undefined;
  size?: number | undefined;
};

export type ParsedAssetChunk = {
  sequence: number;
  byteLength: number;
};

export type ParsedAssetCompletion = {
  size: number;
  sha256: string;
};

/**
 * A start frame is accepted once per transfer, with a usable name and a declared size that
 * fits the budget the controller granted. The parsed frame is returned rather than a verdict,
 * so the caller forwards exactly what was validated.
 */
export const parseAssetStart = (
  transfer: AssetTransferState,
  input: { name?: unknown; mimeType?: unknown; size?: unknown },
): ParsedAssetStart | undefined => {
  if (transfer.started) return undefined;
  const name = input.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 512) {
    return undefined;
  }
  const mimeType = input.mimeType;
  if (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.length > 255)) {
    return undefined;
  }
  const size = input.size;
  if (
    size !== undefined &&
    (typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > transfer.maxBytes)
  ) {
    return undefined;
  }
  return {
    name,
    ...(typeof mimeType === "string" ? { mimeType } : {}),
    ...(typeof size === "number" ? { size } : {}),
  };
};

/**
 * A chunk counts only when the transfer has started, the sequence is exactly the next one
 * expected, the payload decoded, and the running total stays inside the granted budget. A
 * gap, a repeat and an over-budget frame are all rejected, so a content script cannot pad or
 * reorder a transfer the controller is accounting for.
 */
export const parseAssetChunk = (
  transfer: AssetTransferState,
  input: { sequence?: unknown },
  bytes: { byteLength: number } | undefined,
): ParsedAssetChunk | undefined => {
  if (!transfer.started) return undefined;
  const sequence = input.sequence;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    sequence !== transfer.nextSequence
  ) {
    return undefined;
  }
  if (bytes === undefined || transfer.receivedBytes + bytes.byteLength > transfer.maxBytes) {
    return undefined;
  }
  return { sequence, byteLength: bytes.byteLength };
};

/**
 * Completion has to agree with what the transfer actually received, and with the size the
 * start frame declared when it declared one. The digest is checked for shape here; the bytes
 * themselves are the controller's to verify.
 */
export const parseAssetCompletion = (
  transfer: AssetTransferState,
  input: { size?: unknown; sha256?: unknown },
): ParsedAssetCompletion | undefined => {
  if (!transfer.started) return undefined;
  const size = input.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size !== transfer.receivedBytes ||
    (transfer.declaredSize !== undefined && size !== transfer.declaredSize)
  ) {
    return undefined;
  }
  const sha256 = input.sha256;
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256)) {
    return undefined;
  }
  return { size, sha256 };
};

/**
 * The registry is a bounded most-recently-registered list. Re-registering an asset moves it
 * to the end rather than duplicating it, and anything past the limit is evicted, so a long
 * session cannot grow the registry without bound.
 */
export const assetOrderAfterRegistration = (
  order: readonly string[],
  registeredIds: readonly string[],
  limit: number,
): { order: string[]; evicted: string[] } => {
  const appended = registeredIds.filter(
    (id, index) => registeredIds.lastIndexOf(id) === index,
  );
  const next = order.filter((id) => !appended.includes(id)).concat(appended);
  const overflow = Math.max(0, next.length - limit);
  return { order: next.slice(overflow), evicted: next.slice(0, overflow) };
};

/**
 * A content script that answers the fetch without accepting it, or answers with neither
 * outcome while the transfer is still live, has refused the transfer. A late answer for a
 * transfer that is already gone is ignored rather than reported twice.
 */
export const assetFetchAckRejected = (
  result: { success?: unknown; accepted?: unknown } | undefined,
  stillActive: boolean,
): boolean =>
  result?.success === false ||
  result?.accepted === false ||
  (!result?.success && !result?.accepted && stillActive);
