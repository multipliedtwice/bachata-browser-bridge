import type { BrowserProvider, CapturedAsset } from "../protocol/types.js";
import { isHttpOrigin } from "../protocol/types.js";

const segmentTypes = new Set(["text", "codeBlock", "quote"]);
const assetKinds = new Set([
  "generatedFile",
  "artifact",
  "canvas",
  "image",
  "codeArtifact",
]);
const assetSourceElements = new Set(["assistantMessage", "artifactPane"]);
const assetKeys = new Set([
  "id",
  "provider",
  "kind",
  "name",
  "mimeType",
  "size",
  "sourceElement",
  "providerAssetId",
  "downloadAvailable",
  "previewText",
  "sourceOrigin",
]);
const maximumAssets = 100;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

export const validCapturedSegments = (text: string, value: unknown): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }
  let cursor = 0;
  for (const segment of value) {
    if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
      return false;
    }
    const item = segment as Record<string, unknown>;
    if (
      !segmentTypes.has(String(item.type)) ||
      typeof item.text !== "string" ||
      item.text.length === 0 ||
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      Number(item.start) !== cursor ||
      Number(item.end) <= Number(item.start) ||
      Number(item.end) > text.length ||
      text.slice(Number(item.start), Number(item.end)) !== item.text ||
      (item.language !== undefined && typeof item.language !== "string") ||
      (item.language !== undefined && item.type !== "codeBlock")
    ) {
      return false;
    }
    cursor = Number(item.end);
  }
  // `cursor` only advances past a segment whose `end` is within the text, so empty text
  // always leaves it at 0. The empty-text case is the equality, not a second branch.
  return cursor === text.length;
};

export const validCapturedAssets = (
  provider: BrowserProvider,
  value: unknown,
): value is CapturedAsset[] => {
  if (!Array.isArray(value) || value.length > maximumAssets) {
    return false;
  }
  const ids = new Set<string>();
  for (const asset of value) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      return false;
    }
    const item = asset as Record<string, unknown>;
    if (Object.keys(item).some((key) => !assetKeys.has(key))) {
      return false;
    }
    if (
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 200 ||
      ids.has(item.id) ||
      item.provider !== provider ||
      !assetKinds.has(String(item.kind)) ||
      typeof item.name !== "string" ||
      item.name.trim().length === 0 ||
      item.name.length > 512 ||
      (item.mimeType !== undefined &&
        (typeof item.mimeType !== "string" || item.mimeType.length > 255)) ||
      (item.size !== undefined &&
        (!Number.isSafeInteger(item.size) || Number(item.size) < 0)) ||
      !assetSourceElements.has(String(item.sourceElement)) ||
      (item.providerAssetId !== undefined &&
        (typeof item.providerAssetId !== "string" ||
          item.providerAssetId.length > 500)) ||
      typeof item.downloadAvailable !== "boolean" ||
      (item.previewText !== undefined &&
        (typeof item.previewText !== "string" ||
          item.previewText.length > 20_000)) ||
      (item.sourceOrigin !== undefined &&
        (typeof item.sourceOrigin !== "string" ||
          item.sourceOrigin.length > 2_048 ||
          !isHttpOrigin(item.sourceOrigin)))
    ) {
      return false;
    }
    ids.add(item.id);
  }
  return true;
};

export const strictBase64Bytes = (value: unknown): Uint8Array | undefined => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !base64Pattern.test(value)
  ) {
    return undefined;
  }
  // No catch: the anchored pattern plus the length check admit only well-formed base64, so
  // `atob` cannot reject what reaches it. A catch here would be a branch no input can take.
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
