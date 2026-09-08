type BachataAssetProvider = "chatgpt" | "claude" | "generic";

type BachataAssetKind =
  | "generatedFile"
  | "artifact"
  | "canvas"
  | "image"
  | "codeArtifact";

type BachataAssetSourceElement = "assistantMessage" | "artifactPane";

type BachataAssetMetadata = {
  id: string;
  provider: BachataAssetProvider;
  kind: BachataAssetKind;
  name: string;
  mimeType?: string;
  size?: number;
  sourceElement: BachataAssetSourceElement;
  providerAssetId?: string;
  downloadAvailable: boolean;
  previewText?: string;
  // Canonical origin of the provider-supplied source link. A followed redirect may use another
  // origin. This value is shown before the user chooses to save.
  sourceOrigin?: string;
};

type BachataAssetSource = {
  metadata: BachataAssetMetadata;
  url?: string;
  data?: Uint8Array;
  reveal?: () => void;
};

type BachataAssetTransferHooks = {
  start: (metadata: BachataAssetMetadata) => Promise<void>;
  chunk: (sequence: number, dataBase64: string) => Promise<void>;
};

type BachataAssetLogic = {
  createLinkedAsset: (input: {
    provider: BachataAssetProvider;
    documentToken: string;
    sourceElement: BachataAssetSourceElement;
    rawHref: string;
    baseUrl: string;
    download?: string;
    ariaLabel?: string;
    title?: string;
    textContent?: string;
    providerAssetId?: string;
    reveal?: () => void;
  }) => BachataAssetSource | undefined;
  discoverLinkedAssets: (
    provider: BachataAssetProvider,
    root: HTMLElement,
    documentToken: string,
    sourceElement?: BachataAssetSourceElement,
  ) => BachataAssetSource[];
  createInlineAsset: (input: {
    provider: BachataAssetProvider;
    documentToken: string;
    kind: BachataAssetKind;
    name: string;
    mimeType: string;
    sourceElement: BachataAssetSourceElement;
    providerAssetId?: string;
    text: string;
    previewText?: string;
  }) => BachataAssetSource;
  transferAsset: (
    source: BachataAssetSource,
    maximumBytes: number,
    signal: AbortSignal,
    hooks: BachataAssetTransferHooks,
  ) => Promise<{ size: number; sha256: string }>;
  serializedByteLength: (value: unknown) => number;
  toPublicMetadata: (source: BachataAssetSource) => BachataAssetMetadata;
  sanitizeName: (value: string, fallback: string) => string;
};

type BachataAssetGlobal = typeof globalThis & {
  __pairAssetLogic?: BachataAssetLogic;
};

const bachataAssetMaximumInlineBytes = 16 * 1024 * 1024;

const bachataAssetExtensionMimeTypes = new Map<string, string>([
  [".csv", "text/csv"],
  [".doc", "application/msword"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".gif", "image/gif"],
  [".html", "text/html"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".xls", "application/vnd.ms-excel"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

const bachataAssetSha256Constants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/*
 * Hand-written because SubtleCrypto exposes no incremental digest: `crypto.subtle.digest`
 * takes one complete buffer. Asset transfers stream in 128 KiB chunks and may exceed the
 * inline limit, so buffering an entire asset only to hash it is not an option. This is the
 * narrow exception to preferring the platform primitive, and it is covered by
 * tests/assetLogic.test.mjs against known vectors.
 */
class BachataAssetSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0n;
  private completed = false;

  update(input: Uint8Array): void {
    if (this.completed) {
      throw new Error("SHA-256 digest is already complete");
    }
    this.totalLength += BigInt(input.byteLength);
    let offset = 0;
    while (offset < input.byteLength) {
      const count = Math.min(
        this.buffer.byteLength - this.bufferLength,
        input.byteLength - offset,
      );
      this.buffer.set(input.subarray(offset, offset + count), this.bufferLength);
      this.bufferLength += count;
      offset += count;
      if (this.bufferLength === this.buffer.byteLength) {
        this.transform(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  digestHex(): string {
    if (!this.completed) {
      const bitLength = this.totalLength * 8n;
      this.buffer[this.bufferLength] = 0x80;
      this.bufferLength += 1;
      if (this.bufferLength > 56) {
        this.buffer.fill(0, this.bufferLength);
        this.transform(this.buffer);
        this.bufferLength = 0;
      }
      this.buffer.fill(0, this.bufferLength, 56);
      for (let index = 0; index < 8; index += 1) {
        this.buffer[63 - index] = Number(
          (bitLength >> BigInt(index * 8)) & 0xffn,
        );
      }
      this.transform(this.buffer);
      this.completed = true;
    }
    return Array.from(this.state)
      .map((value) => value.toString(16).padStart(8, "0"))
      .join("");
  }

  private transform(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const word = (index: number): number => words[index] ?? 0;
    const byte = (index: number): number => block[index] ?? 0;
    const state = (index: number): number => this.state[index] ?? 0;
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        ((byte(offset) << 24) |
          (byte(offset + 1) << 16) |
          (byte(offset + 2) << 8) |
          byte(offset + 3)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = word(index - 15);
      const right = word(index - 2);
      const sigma0 =
        (this.rotateRight(left, 7) ^
          this.rotateRight(left, 18) ^
          (left >>> 3)) >>>
        0;
      const sigma1 =
        (this.rotateRight(right, 17) ^
          this.rotateRight(right, 19) ^
          (right >>> 10)) >>>
        0;
      words[index] =
        (word(index - 16) + sigma0 + word(index - 7) + sigma1) >>> 0;
    }

    let a = state(0);
    let b = state(1);
    let c = state(2);
    let d = state(3);
    let e = state(4);
    let f = state(5);
    let g = state(6);
    let h = state(7);

    for (let index = 0; index < 64; index += 1) {
      const sum1 =
        (this.rotateRight(e, 6) ^
          this.rotateRight(e, 11) ^
          this.rotateRight(e, 25)) >>>
        0;
      const choice = ((e & f) ^ (~e & g)) >>> 0;
      const temporary1 =
        (h +
          sum1 +
          choice +
          (bachataAssetSha256Constants[index] ?? 0) +
          word(index)) >>>
        0;
      const sum0 =
        (this.rotateRight(a, 2) ^
          this.rotateRight(a, 13) ^
          this.rotateRight(a, 22)) >>>
        0;
      const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    this.state[0] = (state(0) + a) >>> 0;
    this.state[1] = (state(1) + b) >>> 0;
    this.state[2] = (state(2) + c) >>> 0;
    this.state[3] = (state(3) + d) >>> 0;
    this.state[4] = (state(4) + e) >>> 0;
    this.state[5] = (state(5) + f) >>> 0;
    this.state[6] = (state(6) + g) >>> 0;
    this.state[7] = (state(7) + h) >>> 0;
  }

  private rotateRight(value: number, count: number): number {
    return ((value >>> count) | (value << (32 - count))) >>> 0;
  }
}

// These rules are shared with the Extension, which sanitises the same names again before it
// writes one. `protocol/asset-name.fixtures.json` holds one table both repositories assert
// against, and each pins its digest, so a rule cannot be changed on one side alone.
//
// Bidirectional formatting characters reorder how a name is displayed without changing what
// it is, so a name carrying U+202E can render as though it ended `.png` while the file does
// not. They are removed rather than replaced, so an ordinary name keeps its shape.
const BACHATA_ASSET_BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

// Windows resolves these stems as devices whatever extension follows, so `CON.txt` is not a
// file. The name is prefixed rather than refused, so no asset is silently lost.
const BACHATA_ASSET_WINDOWS_DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

const bachataAssetSanitizeName = (value: string, fallback: string): string => {
  const cleaned = value
    .normalize("NFKC")
    .replace(BACHATA_ASSET_BIDI_CONTROL, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  // The device prefix is charged against the length budget before the cap. Prefixing after
  // it produced a name one character over the limit.
  const prefix = BACHATA_ASSET_WINDOWS_DEVICE_STEM.test(cleaned) ? "_" : "";
  const normalized = (prefix + cleaned)
    .slice(0, 180)
    // Windows drops a trailing dot or space when it creates a file, so the name shown before
    // the save has to match the name that reaches disk. After the cap, which can expose one.
    .replace(/[. ]+$/u, "");
  return normalized || fallback;
};

const bachataAssetNameFromUrl = (
  value: string,
  baseUrl: string,
): string | undefined => {
  try {
    const url = new URL(value, baseUrl);
    const segment = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    return segment && segment !== "download" ? segment : undefined;
  } catch {
    return undefined;
  }
};

const bachataAssetExtension = (name: string): string => {
  const match = name.toLowerCase().match(/(\.[a-z0-9]{1,10})$/);
  return match?.[1] ?? "";
};

const bachataAssetMimeType = (name: string): string | undefined =>
  bachataAssetExtensionMimeTypes.get(bachataAssetExtension(name));

const bachataAssetId = (): string => `asset-${crypto.randomUUID()}`;

const bachataAssetDownloadHint = (input: {
  download?: string;
  declaredDownload?: boolean;
  ariaLabel?: string;
  title?: string;
  textContent?: string;
  url: URL;
}): boolean => {
  if (input.url.protocol === "sandbox:") {
    return true;
  }
  // BR-G6-16. An anchor carrying `download` has already said what it is, in the one place HTML
  // provides for saying it. Reading that attribute as another string to search for English words
  // in meant a link labelled "Télécharger", with `download="rapport.pdf"` and no English path
  // segment, was passed over — and every keyword below is a guess where this is a declaration.
  if (input.declaredDownload === true) {
    return true;
  }
  const hint = [
    input.download,
    input.ariaLabel,
    input.title,
    input.textContent,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return (
    /\b(download|save|export)\b/i.test(hint) ||
    /\/(download|downloads|file|files|artifact|artifacts)(\/|$)/i.test(
      input.url.pathname,
    )
  );
};

// The origin of the link the provider put in the response, derived locally from the already
// resolved URL. Opaque sources (data:, sandbox:, blob: with no embedded origin) report "null",
// which is not an origin, so they get none rather than a guessed one.
const bachataAssetSourceOrigin = (url: URL): string | undefined =>
  url.origin && url.origin !== "null" ? url.origin : undefined;

const bachataAssetKind = (name: string, mimeType: string | undefined): BachataAssetKind =>
  mimeType?.startsWith("image/") ||
  [".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(
    bachataAssetExtension(name),
  )
    ? "image"
    : "generatedFile";

const bachataAssetCreateLinkedAsset = (input: {
  provider: BachataAssetProvider;
  documentToken: string;
  sourceElement: BachataAssetSourceElement;
  rawHref: string;
  baseUrl: string;
  download?: string;
  /** BR-G6-16. Whether the anchor carried a `download` attribute at all, value or not. */
  declaredDownload?: boolean;
  ariaLabel?: string;
  title?: string;
  textContent?: string;
  providerAssetId?: string;
  reveal?: () => void;
}): BachataAssetSource | undefined => {
  let url: URL;
  try {
    url = new URL(input.rawHref, input.baseUrl);
  } catch {
    return undefined;
  }
  if (
    !["https:", "blob:", "data:", "sandbox:"].includes(url.protocol) ||
    !bachataAssetDownloadHint({
      ...(input.download ? { download: input.download } : {}),
      ...(input.declaredDownload === true ? { declaredDownload: true } : {}),
      ...(input.ariaLabel ? { ariaLabel: input.ariaLabel } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.textContent ? { textContent: input.textContent } : {}),
      url,
    })
  ) {
    return undefined;
  }
  const suggested =
    input.download ||
    bachataAssetNameFromUrl(url.toString(), input.baseUrl) ||
    input.textContent ||
    input.ariaLabel ||
    input.title ||
    "generated-file";
  const name = bachataAssetSanitizeName(suggested, "generated-file");
  const mimeType = bachataAssetMimeType(name);
  const downloadAvailable = ["https:", "blob:", "data:"].includes(
    url.protocol,
  );
  const sourceOrigin = downloadAvailable
    ? bachataAssetSourceOrigin(url)
    : undefined;
  return {
    metadata: {
      id: bachataAssetId(),
      provider: input.provider,
      kind: bachataAssetKind(name, mimeType),
      name,
      ...(mimeType ? { mimeType } : {}),
      sourceElement: input.sourceElement,
      ...(input.providerAssetId
        ? { providerAssetId: input.providerAssetId }
        : {}),
      downloadAvailable,
      ...(sourceOrigin === undefined ? {} : { sourceOrigin }),
    },
    ...(downloadAvailable ? { url: url.toString() } : {}),
    ...(input.reveal ? { reveal: input.reveal } : {}),
  };
};

const bachataAssetTransferHref = (
  element: HTMLElement,
  fallback: string | undefined,
): string | undefined => {
  const candidates = [
    element.getAttribute("data-download-url"),
    element.getAttribute("data-file-url"),
    element.getAttribute("data-asset-url"),
    element.getAttribute("data-url"),
    element.getAttribute("data-href"),
    fallback,
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, location.href);
      if (["https:", "blob:", "data:"].includes(url.protocol)) {
        return candidate;
      }
    } catch {
      // BB-AUD-10. These attributes are provider markup: one that is not a URL is not a
      // transfer source, and the next candidate is tried.
    }
  }
  return fallback;
};

const bachataAssetProviderOnlyControl = (
  provider: BachataAssetProvider,
  element: HTMLElement,
  documentToken: string,
  sourceElement: BachataAssetSourceElement,
): BachataAssetSource | undefined => {
  if (element.closest("a[href]")) {
    return undefined;
  }
  const ariaLabel = element.getAttribute("aria-label") ?? undefined;
  const title = element.getAttribute("title") ?? undefined;
  const textContent = element.textContent?.trim() || undefined;
  const hint = [
    ariaLabel,
    title,
    textContent,
    element.getAttribute("data-testid") ?? undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const providerAssetId =
    element.getAttribute("data-file-id") ??
    element.getAttribute("data-asset-id") ??
    element.getAttribute("data-testid") ??
    (element.id || undefined);
  if (!/\b(download|save|export)\b/i.test(hint) || !providerAssetId) {
    return undefined;
  }
  // BB-A4-N08. A filename the control states outright is the best name there is, and it is the
  // only one that survives an opaque transfer URL: `.../f/9f2` has no basename worth keeping and
  // no extension to read a type from.
  const declaredFilename =
    element.getAttribute("data-filename") ??
    element.getAttribute("data-file-name") ??
    undefined;
  const suggested =
    declaredFilename ??
    title ??
    ariaLabel ??
    textContent ??
    "generated-file";
  const transferHref = bachataAssetTransferHref(element, undefined);
  if (transferHref) {
    return bachataAssetCreateLinkedAsset({
      provider,
      documentToken,
      sourceElement,
      rawHref: transferHref,
      baseUrl: location.href,
      ...(declaredFilename ? { download: declaredFilename } : {}),
      ...(ariaLabel ? { ariaLabel } : {}),
      ...(title ? { title } : {}),
      ...(textContent ? { textContent } : {}),
      providerAssetId,
      reveal: () => {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        element.focus({ preventScroll: true });
      },
    });
  }
  const name = bachataAssetSanitizeName(suggested, "generated-file");
  const mimeType = bachataAssetMimeType(name);
  return {
    metadata: {
      id: bachataAssetId(),
      provider,
      kind: bachataAssetKind(name, mimeType),
      name,
      ...(mimeType ? { mimeType } : {}),
      sourceElement,
      providerAssetId,
      downloadAvailable: false,
    },
    reveal: () => {
      element.scrollIntoView({ block: "center", inline: "nearest" });
      element.focus({ preventScroll: true });
    },
  };
};

const bachataAssetDiscoverLinkedAssets = (
  provider: BachataAssetProvider,
  root: HTMLElement,
  documentToken: string,
  sourceElement: BachataAssetSourceElement = "assistantMessage",
): BachataAssetSource[] => {
  const seen = new Set<string>();
  const linked = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .flatMap((anchor) => {
      const rawHref = bachataAssetTransferHref(
        anchor,
        anchor.getAttribute("href") ?? anchor.href,
      ) ?? anchor.href;
      const providerAssetId =
        anchor.getAttribute("data-file-id") ??
        anchor.getAttribute("data-asset-id") ??
        anchor.getAttribute("data-testid") ??
        (anchor.id || undefined);
      const source = bachataAssetCreateLinkedAsset({
        provider,
        documentToken,
        sourceElement,
        rawHref,
        baseUrl: location.href,
        ...(anchor.download ? { download: anchor.download } : {}),
        // BR-G6-16. Present with no value is still a declaration, and the `download` property
        // is the empty string then, so the attribute itself is what is asked about.
        ...(anchor.getAttribute("download") !== null ? { declaredDownload: true } : {}),
        ...(anchor.getAttribute("aria-label") ? { ariaLabel: anchor.getAttribute("aria-label") ?? "" } : {}),
        ...(anchor.getAttribute("title") ? { title: anchor.getAttribute("title") ?? "" } : {}),
        ...(anchor.textContent?.trim() ? { textContent: anchor.textContent.trim() } : {}),
        ...(providerAssetId ? { providerAssetId } : {}),
        reveal: () => {
          anchor.scrollIntoView({ block: "center", inline: "nearest" });
          anchor.focus({ preventScroll: true });
        },
      });
      if (!source) {
        return [];
      }
      const identity = `${provider}:${rawHref}:${source.metadata.name}:${providerAssetId ?? ""}`;
      if (seen.has(identity)) {
        return [];
      }
      seen.add(identity);
      return [source];
    });
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(
      "button, [role='button'], [data-file-id], [data-asset-id]",
    ),
  ).flatMap((element) => {
    const source = bachataAssetProviderOnlyControl(
      provider,
      element,
      documentToken,
      sourceElement,
    );
    if (!source) {
      return [];
    }
    const identity = `${provider}:control:${source.metadata.providerAssetId ?? ""}:${source.metadata.name}`;
    if (seen.has(identity)) {
      return [];
    }
    seen.add(identity);
    return [source];
  });
  return [...linked, ...controls];
};

const bachataAssetCreateInlineAsset = (input: {
  provider: BachataAssetProvider;
  documentToken: string;
  kind: BachataAssetKind;
  name: string;
  mimeType: string;
  sourceElement: BachataAssetSourceElement;
  providerAssetId?: string;
  text: string;
  previewText?: string;
}): BachataAssetSource => {
  const name = bachataAssetSanitizeName(input.name, "artifact.txt");
  const data = new TextEncoder().encode(input.text);
  const downloadAvailable = data.byteLength <= bachataAssetMaximumInlineBytes;
  return {
    metadata: {
      id: bachataAssetId(),
      provider: input.provider,
      kind: input.kind,
      name,
      mimeType: input.mimeType,
      size: data.byteLength,
      sourceElement: input.sourceElement,
      ...(input.providerAssetId
        ? { providerAssetId: input.providerAssetId }
        : {}),
      downloadAvailable,
      ...(input.previewText ? { previewText: input.previewText } : {}),
    },
    ...(downloadAvailable ? { data } : {}),
  };
};

const bachataAssetToBase64 = (bytes: Uint8Array): string => {
  let result = "";
  const maximum = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += maximum) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + maximum));
  }
  return btoa(result);
};

/**
 * BR-G6-18. Whatever the transfer holds open, released on every exit from it.
 *
 * The consuming loop calls `return()` on this generator when it throws, so the teardown runs on
 * a refused transfer exactly as it does on a finished one.
 */
const bachataAssetReleasingChunks = async function* (
  chunks: AsyncIterable<Uint8Array>,
  release: () => void,
): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks;
  } finally {
    release();
  }
};

const bachataAssetReadResponse = async function* (
  response: Response,
): AsyncGenerator<Uint8Array> {
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        if (result.value.byteLength > 0) {
          yield result.value;
        }
      }
    } finally {
      // BR-G6-18. Releasing the lock leaves the body streaming. A transfer that ended early —
      // over its limit, mismatched, cancelled — has to tell the stream to stop, or the download
      // it just refused keeps running to completion behind it.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const value = new Uint8Array(await response.arrayBuffer());
  if (value.byteLength > 0) {
    yield value;
  }
};

const bachataAssetTransferAsset = async (
  source: BachataAssetSource,
  maximumBytes: number,
  signal: AbortSignal,
  hooks: BachataAssetTransferHooks,
): Promise<{ size: number; sha256: string }> => {
  if (signal.aborted) {
    throw new DOMException("Asset transfer was cancelled", "AbortError");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Asset transfer limit is invalid");
  }

  let contentLength = source.data?.byteLength;
  let mimeType = source.metadata.mimeType;
  let resolvedUrl: URL | undefined;
  if (source.url) {
    try {
      resolvedUrl = new URL(source.url, location.href);
    } catch {
      resolvedUrl = undefined;
    }
  }
  const sourceOrigin = resolvedUrl
    ? bachataAssetSourceOrigin(resolvedUrl)
    : undefined;
  let chunks: AsyncIterable<Uint8Array>;
  // BR-G6-18. The fetch gets a controller of its own, chained to the caller's, so a transfer that
  // fails for a reason that is not a cancellation — over its limit, or a size that does not match
  // what was advertised — still aborts the request rather than leaving it downloading.
  let releaseTransfer: () => void = () => undefined;
  const releaseCurrentTransfer = (): void => {
    releaseTransfer();
  };
  if (source.data) {
    chunks = bachataAssetReleasingChunks(
      (async function* (): AsyncGenerator<Uint8Array> {
        yield source.data as Uint8Array;
      })(),
      releaseCurrentTransfer,
    );
  } else if (source.url) {
    // Credentials belong to the provider, not to whatever origin a link in the response
    // names. A model can emit an anchor to any https host, and that asset is offered to the
    // user as a provider asset; sending the provider session's cookies to a third party
    // because of it is not something the user agreed to.
    //
    // "same-origin" is decided per request in the redirect chain, so a provider URL that
    // redirects to another origin reaches that origin with no credentials attached.
    // Deciding once from the pre-redirect URL and passing "include" did the opposite: the
    // one case that needed protection, a same-origin link redirecting away, was the case
    // that carried the session.
    const transferAbort = new AbortController();
    const forwardAbort = (): void => {
      transferAbort.abort();
    };
    // An already-aborted transfer never reaches here: the guard at the top of this function
    // throws first, so the listener is the only path a cancellation takes.
    signal.addEventListener("abort", forwardAbort, { once: true });
    releaseTransfer = () => {
      signal.removeEventListener("abort", forwardAbort);
      transferAbort.abort();
    };
    const response = await fetch(source.url, {
      credentials: "same-origin",
      redirect: "follow",
      signal: transferAbort.signal,
    });
    if (!response.ok) {
      releaseTransfer();
      throw new Error(`Asset download failed with HTTP ${String(response.status)}`);
    }
    const lengthHeader = response.headers.get("content-length");
    const contentEncoding = response.headers.get("content-encoding");
    // BR-G6-17. `content-length` is CORS-safelisted and `content-encoding` is not, so on a
    // cross-origin response the encoding header reads as absent whether the body is compressed
    // or not — while the length that *is* visible describes the compressed bytes and the stream
    // below yields the decoded ones. An absent header cannot be told from a hidden one, so the
    // number is only trusted where every header is visible. Where it is not, the streaming limit
    // below is the bound; an unverifiable number is not one.
    const everyHeaderVisible = response.type === "basic" || response.type === "default";
    if (
      everyHeaderVisible &&
      (!contentEncoding || contentEncoding.toLowerCase() === "identity") &&
      lengthHeader &&
      /^\d+$/.test(lengthHeader)
    ) {
      contentLength = Number(lengthHeader);
    }
    mimeType = response.headers.get("content-type")?.split(";")[0] || mimeType;
    chunks = bachataAssetReleasingChunks(bachataAssetReadResponse(response), releaseCurrentTransfer);
  } else {
    throw new Error("Asset data is unavailable");
  }

  if (contentLength !== undefined && contentLength > maximumBytes) {
    releaseTransfer();
    throw new Error(`Asset exceeds the ${String(maximumBytes)} byte limit`);
  }

  const metadata: BachataAssetMetadata = {
    ...source.metadata,
    ...(sourceOrigin === undefined ? {} : { sourceOrigin }),
    ...(mimeType ? { mimeType } : {}),
    ...(contentLength !== undefined ? { size: contentLength } : {}),
  };
  try {
    await hooks.start(metadata);
  } catch (cause) {
    releaseTransfer();
    throw cause;
  }

  const digest = new BachataAssetSha256();
  let size = 0;
  let sequence = 0;
  const transferChunkBytes = 128 * 1024;
  for await (const value of chunks) {
    if (signal.aborted) {
      throw new DOMException("Asset transfer was cancelled", "AbortError");
    }
    for (let offset = 0; offset < value.byteLength; offset += transferChunkBytes) {
      if (signal.aborted) {
        throw new DOMException("Asset transfer was cancelled", "AbortError");
      }
      const chunk = value.subarray(
        offset,
        Math.min(value.byteLength, offset + transferChunkBytes),
      );
      size += chunk.byteLength;
      if (size > maximumBytes) {
        throw new Error(`Asset exceeds the ${String(maximumBytes)} byte limit`);
      }
      digest.update(chunk);
      await hooks.chunk(sequence, bachataAssetToBase64(chunk));
      sequence += 1;
    }
  }
  if (contentLength !== undefined && size !== contentLength) {
    throw new Error("Asset size does not match its advertised content length");
  }
  return { size, sha256: digest.digestHex() };
};

const bachataAssetSerializedByteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const bachataAssetLogic: BachataAssetLogic = {
  createLinkedAsset: bachataAssetCreateLinkedAsset,
  discoverLinkedAssets: bachataAssetDiscoverLinkedAssets,
  createInlineAsset: bachataAssetCreateInlineAsset,
  transferAsset: bachataAssetTransferAsset,
  serializedByteLength: bachataAssetSerializedByteLength,
  toPublicMetadata: (source) => ({ ...source.metadata }),
  // Exposed for the shared filename fixture table only. The Extension asserts the same table
  // against its own sanitiser, so neither side can relax a rule alone.
  sanitizeName: bachataAssetSanitizeName,
};

(globalThis as BachataAssetGlobal).__pairAssetLogic = bachataAssetLogic;
