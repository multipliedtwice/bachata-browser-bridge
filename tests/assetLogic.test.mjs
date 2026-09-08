import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

await import("../dist/content/assetLogic.js");

const logic = globalThis.__pairAssetLogic;

test("inline browser assets use collision-resistant identities and bounded metadata", () => {
  const input = {
    provider: "claude",
    documentToken: "document-token",
    kind: "codeArtifact",
    name: "artifact.ts",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text: "export const value = 1;",
  };
  const first = logic.createInlineAsset(input);
  const second = logic.createInlineAsset(input);

  assert.notEqual(first.metadata.id, second.metadata.id);
  assert.match(first.metadata.id, /^asset-[0-9a-f-]{36}$/i);
  assert.equal(first.metadata.downloadAvailable, true);
  assert.equal(first.metadata.size, Buffer.byteLength(input.text));
});

test("inline browser asset transfer streams exact bytes and SHA-256", async () => {
  const text = "artifact🙂\n".repeat(30_000);
  const source = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "artifact.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text,
  });
  const starts = [];
  const chunks = [];
  const result = await logic.transferAsset(
    source,
    2 * 1024 * 1024,
    new AbortController().signal,
    {
      start: async (metadata) => starts.push(metadata),
      chunk: async (sequence, dataBase64) => {
        chunks.push({ sequence, data: Buffer.from(dataBase64, "base64") });
      },
    },
  );
  const bytes = Buffer.concat(chunks.map((chunk) => chunk.data));

  assert.equal(starts.length, 1);
  assert.deepEqual(
    chunks.map((chunk) => chunk.sequence),
    chunks.map((_, index) => index),
  );
  assert.equal(bytes.toString("utf8"), text);
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("oversized inline artifacts are represented without retaining downloadable bytes", () => {
  const text = "x".repeat(16 * 1024 * 1024 + 1);
  const source = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "large.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text,
    previewText: "preview",
  });

  assert.equal(source.metadata.size, text.length);
  assert.equal(source.metadata.downloadAvailable, false);
  assert.equal(source.metadata.previewText, "preview");
  assert.equal(source.data, undefined);
});

test("an already-aborted asset transfer emits no transfer events", async () => {
  const source = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "artifact.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text: "value",
  });
  const controller = new AbortController();
  controller.abort();
  let started = false;

  await assert.rejects(
    logic.transferAsset(source, 1024, controller.signal, {
      start: async () => {
        started = true;
      },
      chunk: async () => undefined,
    }),
    /cancelled/,
  );
  assert.equal(started, false);
});

test("encoded asset responses do not compare decoded bytes with encoded content length", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = new TextEncoder().encode("decoded payload");
  globalThis.fetch = async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-length": "1",
        "content-encoding": "gzip",
        "content-type": "text/plain",
      },
    });
  try {
    const chunks = [];
    const result = await logic.transferAsset(
      {
        metadata: {
          id: "asset-encoded",
          provider: "chatgpt",
          kind: "generatedFile",
          name: "encoded.txt",
          sourceElement: "assistantMessage",
          downloadAvailable: true,
        },
        url: "https://example.invalid/encoded.txt",
      },
      1024,
      new AbortController().signal,
      {
        start: async () => undefined,
        chunk: async (_sequence, dataBase64) => {
          chunks.push(Buffer.from(dataBase64, "base64"));
        },
      },
    );
    assert.equal(Buffer.concat(chunks).toString("utf8"), "decoded payload");
    assert.equal(result.size, bytes.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider sandbox links are captured as provider-only assets", () => {
  const source = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "sandbox:/mnt/data/report.docx",
    baseUrl: "https://chatgpt.com/c/example",
    textContent: "Download report",
    providerAssetId: "file-report",
  });

  assert.ok(source);
  assert.equal(source.metadata.name, "report.docx");
  assert.equal(source.metadata.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(source.metadata.downloadAvailable, false);
  assert.equal(source.metadata.providerAssetId, "file-report");
  assert.equal(source.url, undefined);
});

test("authenticated provider links remain directly transferable", () => {
  const source = logic.createLinkedAsset({
    provider: "claude",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "/api/files/result.pdf",
    baseUrl: "https://claude.ai/chat/example",
    ariaLabel: "Download result",
  });

  assert.ok(source);
  assert.equal(source.metadata.name, "result.pdf");
  assert.equal(source.metadata.mimeType, "application/pdf");
  assert.equal(source.metadata.downloadAvailable, true);
  assert.equal(source.url, "https://claude.ai/api/files/result.pdf");
});


test("linked browser assets reject unsafe protocols and sanitize suggested names", () => {
  assert.equal(
    logic.createLinkedAsset({
      provider: "chatgpt",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "javascript:alert(1)",
      baseUrl: "https://chatgpt.com/c/example",
      textContent: "Download",
    }),
    undefined,
  );
  assert.equal(
    logic.createLinkedAsset({
      provider: "chatgpt",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "https://example.invalid/view/report.pdf",
      baseUrl: "https://chatgpt.com/c/example",
      textContent: "Open report",
    }),
    undefined,
  );
  const source = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "https://example.invalid/download/report.pdf",
    baseUrl: "https://chatgpt.com/c/example",
    download: "../bad:<name>.pdf",
  });
  assert.ok(source);
  assert.equal(/[\\/:*?"<>|]/u.test(source.metadata.name), false);
  assert.match(source.metadata.name, /bad__name_\.pdf$/u);
});

test("asset discovery deduplicates links and captures provider-only controls", () => {
  const originalLocation = globalThis.location;
  globalThis.location = { href: "https://claude.ai/chat/example" };
  let revealed = 0;
  class Element {
    constructor(attributes = {}, values = {}) {
      this.attributes = new Map(Object.entries(attributes));
      this.href = values.href ?? "";
      this.download = values.download ?? "";
      this.id = values.id ?? "";
      this.textContent = values.textContent ?? "";
      this.anchorParent = values.anchorParent ?? false;
    }
    closest() {
      return this.anchorParent ? {} : null;
    }
    focus() {
      revealed += 1;
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }
    scrollIntoView() {
      revealed += 1;
    }
  }
  const first = new Element(
    { href: "/api/files/report.pdf", "aria-label": "Download report" },
    { href: "https://claude.ai/api/files/report.pdf", textContent: "Report" },
  );
  const duplicate = new Element(
    { href: "/api/files/report.pdf", "aria-label": "Download report" },
    { href: "https://claude.ai/api/files/report.pdf", textContent: "Report" },
  );
  const control = new Element({
    "aria-label": "Download export",
    "data-file-id": "file-1",
    "data-filename": "export.csv",
  });
  const nestedControl = new Element(
    { "aria-label": "Download nested", "data-file-id": "nested" },
    { anchorParent: true },
  );
  const root = {
    querySelectorAll(selector) {
      return selector === "a[href]"
        ? [first, duplicate]
        : [control, nestedControl];
    },
  };
  try {
    const assets = logic.discoverLinkedAssets(
      "claude",
      root,
      "document-token",
    );
    assert.equal(assets.length, 2);
    assert.equal(assets[0].metadata.name, "report.pdf");
    assert.equal(assets[0].metadata.downloadAvailable, true);
    assert.equal(assets[1].metadata.name, "export.csv");
    assert.equal(assets[1].metadata.downloadAvailable, false);
    assets.forEach((asset) => asset.reveal?.());
    assert.equal(revealed, 4);
  } finally {
    globalThis.location = originalLocation;
  }
});

// BB-A4-N08. A control that states its own filename and also carries a transfer URL used to lose
// that filename: construction fell back to the URL's basename, which an opaque provider URL turns
// into a meaningless name with no extension and therefore no type.
test("a download control keeps the filename it declares even behind an opaque transfer URL", () => {
  const originalLocation = globalThis.location;
  globalThis.location = { href: "https://claude.ai/chat/example" };
  class Control {
    constructor(attributes) {
      this.attributes = new Map(Object.entries(attributes));
      this.href = "";
      this.download = "";
      this.id = "";
      this.textContent = "";
    }
    closest() { return null; }
    focus() {}
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    scrollIntoView() {}
  }
  const control = new Control({
    "aria-label": "Download",
    "data-file-id": "file-9",
    "data-download-url": "https://claude.ai/f/9f2",
    "data-filename": "report.pdf",
  });
  const root = {
    querySelectorAll: (selector) => (selector === "a[href]" ? [] : [control]),
  };
  try {
    const assets = logic.discoverLinkedAssets("claude", root, "document-token");
    assert.equal(assets.length, 1);
    assert.equal(assets[0].metadata.name, "report.pdf");
    assert.equal(assets[0].metadata.mimeType, "application/pdf");
  } finally {
    globalThis.location = originalLocation;
  }
});

// BR-G6-16. An anchor carrying `download` has already said what it is, in the one place HTML
// provides for saying it. Reading that attribute as another string to search English keywords in
// meant a link whose label, filename and path are not English was passed over entirely — the
// asset never appeared, and nothing said why.
test("a link that declares itself a download is captured whatever language it is in", () => {
  const originalLocation = globalThis.location;
  globalThis.location = { href: "https://claude.ai/chat/example" };
  let revealedDeclared = 0;
  class Anchor {
    constructor(attributes, values = {}) {
      this.attributes = new Map(Object.entries(attributes));
      this.href = values.href ?? "";
      this.download = values.download ?? "";
      this.id = "";
      this.textContent = values.textContent ?? "";
    }
    closest() { return null; }
    focus() { revealedDeclared += 1; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    scrollIntoView() { revealedDeclared += 1; }
  }
  const declared = new Anchor(
    { download: "rapport.pdf" },
    { href: "https://claude.ai/f/9f2", download: "rapport.pdf", textContent: "Télécharger" },
  );
  // Nothing declares this one, and nothing about it reads as a download in any language.
  const undeclared = new Anchor({}, { href: "https://claude.ai/f/aa1", textContent: "Rapport" });
  // A provider-only control that carries its own transfer URL, and the same control twice: the
  // second is the same asset and is not offered again.
  const control = new Anchor(
    {
      "aria-label": "Download export",
      "data-file-id": "file-9",
      "data-download-url": "https://claude.ai/f/export.csv",
      "data-filename": "export.csv",
    },
    {},
  );
  const duplicateControl = new Anchor(
    {
      "aria-label": "Download export",
      "data-file-id": "file-9",
      "data-download-url": "https://claude.ai/f/export.csv",
      "data-filename": "export.csv",
    },
    {},
  );
  const root = {
    querySelectorAll: (selector) => (selector === "a[href]"
      ? [declared, undeclared]
      : [control, duplicateControl]),
  };
  try {
    const assets = logic.discoverLinkedAssets("claude", root, "document-token");
    assert.deepEqual(
      assets.map((asset) => asset.metadata.name),
      ["rapport.pdf", "export.csv"],
      "the declared download, the control's own transfer URL, or the duplicate were mishandled",
    );
    // The reveal a captured asset offers is part of what discovery returns, so it is exercised
    // rather than only described.
    assets.forEach((asset) => asset.reveal?.());
    assert.equal(revealedDeclared, 4, "a captured asset could not be revealed");
  } finally {
    globalThis.location = originalLocation;
  }
});

// BR-G6-17. `content-length` is CORS-safelisted; `content-encoding` is not. On a cross-origin
// response the encoding header reads as absent whether the body is compressed or not, while the
// length that is visible describes the compressed bytes and the stream yields the decoded ones —
// so every compressed cross-origin asset failed as a size mismatch.
test("a cross-origin length is not trusted against decoded bytes", async () => {
  const originalFetch = globalThis.fetch;
  const hooks = { start: async () => undefined, chunk: async () => undefined };
  const signal = new AbortController().signal;
  const source = (id) => ({
    metadata: {
      id,
      provider: "chatgpt",
      kind: "generatedFile",
      name: "value.txt",
      sourceElement: "assistantMessage",
      downloadAvailable: true,
    },
    url: "https://example.invalid/value.txt",
  });
  const decoded = new TextEncoder().encode("decoded value");
  const respond = (type) => async () => ({
    ok: true,
    status: 200,
    type,
    // The compressed length, which is all a cross-origin reader can see.
    headers: new Headers({ "content-length": "5" }),
    body: null,
    arrayBuffer: async () => decoded.slice().buffer,
  });
  try {
    globalThis.fetch = respond("cors");
    const transferred = await logic.transferAsset(source("cors-gzip"), 1_000, signal, hooks);
    assert.equal(transferred.size, decoded.byteLength);

    // The same disagreement where every header is visible is a real mismatch and still fails.
    globalThis.fetch = respond("basic");
    await assert.rejects(
      logic.transferAsset(source("same-origin-mismatch"), 1_000, signal, hooks),
      /does not match its advertised content length/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// BR-G6-18. A transfer that fails for a reason that is not a cancellation used to leave the
// response body streaming and the request running: the download it had just refused carried on
// to completion behind it.
test("a refused transfer cancels its body and aborts its request", async () => {
  const originalFetch = globalThis.fetch;
  const hooks = { start: async () => undefined, chunk: async () => undefined };
  const signal = new AbortController().signal;
  let cancelled = 0;
  let aborted = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      init.signal.addEventListener("abort", () => {
        aborted += 1;
      });
      return {
        ok: true,
        status: 200,
        type: "basic",
        headers: new Headers(),
        body: new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64));
          },
          cancel() {
            cancelled += 1;
          },
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    await assert.rejects(
      logic.transferAsset(
        {
          metadata: {
            id: "endless",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "value.bin",
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
          url: "https://example.invalid/value.bin",
        },
        100,
        signal,
        hooks,
      ),
      /exceeds the 100 byte limit/u,
    );
    assert.equal(cancelled, 1, "the refused transfer left its response body streaming");
    assert.equal(aborted, 1, "the refused transfer left its request running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// BR-G6-18. The two remaining exits from a transfer: the caller cancelling it, and the consumer
// of the frames refusing to take them. Both have to reach the same teardown as a refusal does.
test("a cancelled transfer and a refused start both release the transfer", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  let aborted = 0;
  const endlessResponse = (init) => {
    init.signal.addEventListener("abort", () => {
      aborted += 1;
    });
    return {
      ok: true,
      status: 200,
      type: "basic",
      headers: new Headers(),
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled += 1;
        },
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  const source = (id) => ({
    metadata: {
      id,
      provider: "chatgpt",
      kind: "generatedFile",
      name: "value.bin",
      sourceElement: "assistantMessage",
      downloadAvailable: true,
    },
    url: "https://example.invalid/value.bin",
  });
  try {
    globalThis.fetch = async (_url, init) => endlessResponse(init);

    const controller = new AbortController();
    const cancelling = logic.transferAsset(source("cancelled"), 1_000_000, controller.signal, {
      start: async () => undefined,
      chunk: async () => {
        controller.abort();
      },
    });
    await assert.rejects(cancelling, (error) => error.name === "AbortError");
    assert.equal(cancelled, 1, "a cancelled transfer left its response body streaming");
    assert.equal(aborted, 1, "a cancelled transfer left its request running");

    // A consumer that refuses the transfer before the first frame is the same exit.
    await assert.rejects(
      logic.transferAsset(source("refused-start"), 1_000_000, new AbortController().signal, {
        start: async () => {
          throw new Error("the transfer was not admitted");
        },
        chunk: async () => undefined,
      }),
      /not admitted/u,
    );
    assert.equal(aborted, 2, "a refused start left its request running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A transfer of data already in hand has nothing to release, and releasing nothing is not an
// error: the same exit runs for it as for a network transfer.
test("an inline asset transfers through the same release path", async () => {
  const transferred = await logic.transferAsset(
    {
      metadata: {
        id: "inline",
        provider: "chatgpt",
        kind: "generatedFile",
        name: "value.txt",
        sourceElement: "assistantMessage",
        downloadAvailable: true,
      },
      data: new TextEncoder().encode("inline value"),
    },
    1_000,
    new AbortController().signal,
    { start: async () => undefined, chunk: async () => undefined },
  );
  assert.equal(transferred.size, 12);
});

test("asset transfers validate limits, availability, HTTP status, and advertised sizes", async () => {
  const hooks = { start: async () => undefined, chunk: async () => undefined };
  const signal = new AbortController().signal;
  await assert.rejects(
    logic.transferAsset(
      {
        metadata: {
          id: "invalid-limit",
          provider: "chatgpt",
          kind: "generatedFile",
          name: "value.txt",
          sourceElement: "assistantMessage",
          downloadAvailable: true,
        },
        data: new Uint8Array([1]),
      },
      0,
      signal,
      hooks,
    ),
    /limit is invalid/u,
  );
  await assert.rejects(
    logic.transferAsset(
      {
        metadata: {
          id: "unavailable",
          provider: "chatgpt",
          kind: "generatedFile",
          name: "value.txt",
          sourceElement: "assistantMessage",
          downloadAvailable: false,
        },
      },
      10,
      signal,
      hooks,
    ),
    /data is unavailable/u,
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("missing", { status: 404 });
    await assert.rejects(
      logic.transferAsset(
        {
          metadata: {
            id: "http-error",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "value.txt",
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
          url: "https://example.invalid/value.txt",
        },
        100,
        signal,
        hooks,
      ),
      /HTTP 404/u,
    );

    globalThis.fetch = async () => new Response("value", {
      headers: { "content-length": "100" },
    });
    await assert.rejects(
      logic.transferAsset(
        {
          metadata: {
            id: "too-large",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "value.txt",
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
          url: "https://example.invalid/value.txt",
        },
        50,
        signal,
        hooks,
      ),
      /exceeds the 50 byte limit/u,
    );

    globalThis.fetch = async () => new Response("abc", {
      headers: { "content-length": "4" },
    });
    await assert.rejects(
      logic.transferAsset(
        {
          metadata: {
            id: "size-mismatch",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "value.txt",
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
          url: "https://example.invalid/value.txt",
        },
        100,
        signal,
        hooks,
      ),
      /advertised content length/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("asset cancellation stops buffered transfers between chunks", async () => {
  const controller = new AbortController();
  const source = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "large.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text: "x".repeat(300_000),
  });
  let chunks = 0;
  await assert.rejects(
    logic.transferAsset(source, 400_000, controller.signal, {
      start: async () => undefined,
      chunk: async () => {
        chunks += 1;
        controller.abort();
      },
    }),
    /cancelled/u,
  );
  assert.equal(chunks, 1);
});

test("asset metadata serialization is bounded to public values", () => {
  const source = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "value.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text: "value",
  });
  const metadata = logic.toPublicMetadata(source);
  metadata.name = "changed.txt";
  assert.equal(source.metadata.name, "value.txt");
  assert.equal(logic.serializedByteLength({ value: "🙂" }), Buffer.byteLength(JSON.stringify({ value: "🙂" })));
});

test("linked asset metadata names its source origin before any transfer", () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("public metadata must not fetch");
  };
  try {
    const source = logic.createLinkedAsset({
      provider: "claude",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "/api/files/result.pdf?token=secret#page=2",
      baseUrl: "https://claude.ai/chat/example",
      ariaLabel: "Download result",
    });

    assert.ok(source);
    assert.equal(source.metadata.sourceOrigin, "https://claude.ai");
    assert.equal(logic.toPublicMetadata(source).sourceOrigin, "https://claude.ai");
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cross-origin linked asset metadata exposes only the canonical origin", () => {
  const source = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "https://cdn.example.invalid:8443/download/report.pdf?token=secret#part",
    baseUrl: "https://chatgpt.com/c/example",
    textContent: "Download report",
  });

  assert.ok(source);
  assert.equal(source.metadata.sourceOrigin, "https://cdn.example.invalid:8443");
  const serialized = JSON.stringify(logic.toPublicMetadata(source));
  assert.doesNotMatch(serialized, /token=secret/u);
  assert.doesNotMatch(serialized, /\/download\//u);
  assert.doesNotMatch(serialized, /#part/u);
});

test("a non-opaque blob asset exposes its embedded origin", () => {
  const source = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "blob:https://chatgpt.com/2a1b3c4d-1111-2222-3333-444455556666",
    baseUrl: "https://chatgpt.com/c/example",
    download: "chart.png",
    textContent: "Download chart",
  });

  assert.ok(source);
  assert.equal(source.metadata.sourceOrigin, "https://chatgpt.com");
});

test("data, opaque, and unparsable asset sources invent no origin", () => {
  const dataUrl = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "data:text/plain;base64,aGVsbG8=",
    baseUrl: "https://chatgpt.com/c/example",
    download: "note.txt",
    textContent: "Download note",
  });
  assert.ok(dataUrl);
  assert.equal(dataUrl.metadata.downloadAvailable, true);
  assert.equal("sourceOrigin" in dataUrl.metadata, false);

  const opaqueBlob = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "blob:null/2a1b3c4d-1111-2222-3333-444455556666",
    baseUrl: "https://chatgpt.com/c/example",
    download: "chart.png",
    textContent: "Download chart",
  });
  assert.ok(opaqueBlob);
  assert.equal("sourceOrigin" in opaqueBlob.metadata, false);

  const sandbox = logic.createLinkedAsset({
    provider: "chatgpt",
    documentToken: "document-token",
    sourceElement: "assistantMessage",
    rawHref: "sandbox:/mnt/data/report.docx",
    baseUrl: "https://chatgpt.com/c/example",
    textContent: "Download report",
    providerAssetId: "file-report",
  });
  assert.ok(sandbox);
  assert.equal("sourceOrigin" in sandbox.metadata, false);

  assert.equal(
    logic.createLinkedAsset({
      provider: "chatgpt",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "::not a url::",
      baseUrl: "not-a-base",
      textContent: "Download",
    }),
    undefined,
  );
});

test("provider-only controls and inline artifacts carry no source origin", () => {
  const attributes = {
    "aria-label": "Download export",
    "data-file-id": "file-1",
    "data-filename": "export.csv",
  };
  const control = {
    id: "",
    textContent: "Download export",
    closest: () => null,
    getAttribute: (name) => attributes[name] ?? null,
    focus: () => undefined,
    scrollIntoView: () => undefined,
  };
  const root = {
    querySelectorAll: (selector) => (selector === "a[href]" ? [] : [control]),
  };

  const assets = logic.discoverLinkedAssets("claude", root, "document-token");
  assert.equal(assets.length, 1);
  assert.equal(assets[0].metadata.downloadAvailable, false);
  assert.equal("sourceOrigin" in assets[0].metadata, false);

  const inline = logic.createInlineAsset({
    provider: "claude",
    documentToken: "document-token",
    kind: "artifact",
    name: "artifact.txt",
    mimeType: "text/plain",
    sourceElement: "artifactPane",
    text: "value",
  });
  assert.equal("sourceOrigin" in inline.metadata, false);
  assert.equal("sourceOrigin" in logic.toPublicMetadata(inline), false);
});

// BB-AUD-10. Provider markup supplies the transfer URL through data attributes. One that is
// not a URL is not a transfer source, and the next candidate is tried rather than the
// discovery failing.
test("a data attribute that is not a URL is skipped for the next candidate", () => {
  const originalLocation = globalThis.location;
  globalThis.location = { href: "https://claude.ai/chat/1", origin: "https://claude.ai" };
  const attributes = {
    "aria-label": "Download export",
    "data-file-id": "file-1",
    "data-filename": "export.csv",
    "data-download-url": "https://[",
    "data-file-url": "https://cdn.example.invalid/export.csv",
  };
  const control = {
    id: "",
    textContent: "Download export",
    closest: () => null,
    getAttribute: (name) => attributes[name] ?? null,
    focus: () => undefined,
    scrollIntoView: () => undefined,
  };
  const root = {
    querySelectorAll: (selector) => (selector === "a[href]" ? [] : [control]),
  };
  try {
    const assets = logic.discoverLinkedAssets("claude", root, "document-token");
    assert.equal(assets.length, 1);
    assert.equal(assets[0].metadata.downloadAvailable, true);
    assert.equal(assets[0].metadata.sourceOrigin, "https://cdn.example.invalid");
  } finally {
    globalThis.location = originalLocation;
  }
});

test("a control whose every transfer attribute is unusable stays provider-only", () => {
  const originalLocation = globalThis.location;
  globalThis.location = { href: "https://claude.ai/chat/1", origin: "https://claude.ai" };
  const attributes = {
    "aria-label": "Download export",
    "data-file-id": "file-1",
    "data-filename": "export.csv",
    "data-download-url": "https://[",
  };
  const control = {
    id: "",
    textContent: "Download export",
    closest: () => null,
    getAttribute: (name) => attributes[name] ?? null,
    focus: () => undefined,
    scrollIntoView: () => undefined,
  };
  const root = {
    querySelectorAll: (selector) => (selector === "a[href]" ? [] : [control]),
  };
  try {
    const assets = logic.discoverLinkedAssets("claude", root, "document-token");
    assert.equal(assets.length, 1);
    assert.equal(assets[0].metadata.downloadAvailable, false);
    assert.equal("sourceOrigin" in assets[0].metadata, false);
  } finally {
    globalThis.location = originalLocation;
  }
});

test("asset transfer keeps the pre-transfer origin and its credential policy", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const calls = [];
  globalThis.location = {
    href: "https://chatgpt.com/c/example",
    origin: "https://chatgpt.com",
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, credentials: init.credentials });
    return new Response("value", { headers: { "content-type": "text/plain" } });
  };
  try {
    const sameOrigin = logic.createLinkedAsset({
      provider: "chatgpt",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "/backend-api/files/report.txt",
      baseUrl: "https://chatgpt.com/c/example",
      ariaLabel: "Download report",
    });
    assert.ok(sameOrigin);
    assert.equal(sameOrigin.metadata.sourceOrigin, "https://chatgpt.com");
    const sameOriginStarts = [];
    await logic.transferAsset(sameOrigin, 1024, new AbortController().signal, {
      start: async (metadata) => sameOriginStarts.push(metadata),
      chunk: async () => undefined,
    });
    assert.equal(sameOriginStarts[0].sourceOrigin, "https://chatgpt.com");
    // BB-AUD-01. The intent is unchanged — a same-origin asset still fetches with the
    // provider session — but the mode is now decided per redirect hop rather than once from
    // the pre-redirect URL, so a same-origin link that redirects away carries nothing.
    assert.equal(calls[0].credentials, "same-origin");

    const crossOrigin = logic.createLinkedAsset({
      provider: "chatgpt",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "https://cdn.example.invalid/download/report.txt",
      baseUrl: "https://chatgpt.com/c/example",
      textContent: "Download report",
    });
    assert.ok(crossOrigin);
    assert.equal(crossOrigin.metadata.sourceOrigin, "https://cdn.example.invalid");
    const crossOriginStarts = [];
    await logic.transferAsset(crossOrigin, 1024, new AbortController().signal, {
      start: async (metadata) => crossOriginStarts.push(metadata),
      chunk: async () => undefined,
    });
    assert.equal(crossOriginStarts[0].sourceOrigin, "https://cdn.example.invalid");
    assert.equal(calls[1].credentials, "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.location = originalLocation;
  }
});

// BB-AUD-01. `credentials: "include"` is decided once for the whole chain, so a same-origin
// provider URL that redirects to another origin arrives there carrying the session.
// `credentials: "same-origin"` is re-decided per hop, so the destination gets nothing.
test("a same-origin asset URL that redirects cross-origin sends no credentials", async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (input, init) => {
    observed.push({ input: String(input), credentials: init?.credentials, redirect: init?.redirect });
    return new Response("payload", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "7" },
    });
  };
  try {
    const source = logic.createLinkedAsset({
      provider: "claude",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "/api/files/result.txt",
      baseUrl: "https://claude.ai/chat/example",
      ariaLabel: "Download result",
    });
    assert.ok(source);

    const chunks = [];
    const result = await logic.transferAsset(source, 1024, new AbortController().signal, {
      start: async () => undefined,
      chunk: async (sequence, value) => { chunks.push([sequence, value]); },
    });

    assert.equal(observed.length, 1);
    assert.equal(
      observed[0].credentials,
      "same-origin",
      "a credentials mode decided before the redirect cannot protect the destination",
    );
    assert.notEqual(observed[0].credentials, "include");
    assert.equal(observed[0].redirect, "follow");
    assert.equal(result.size, 7);
    assert.equal(chunks.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a cross-origin asset URL still sends no credentials", async () => {
  const originalFetch = globalThis.fetch;
  let credentials;
  globalThis.fetch = async (_input, init) => {
    credentials = init?.credentials;
    return new Response("x", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const source = logic.createLinkedAsset({
      provider: "claude",
      documentToken: "document-token",
      sourceElement: "assistantMessage",
      rawHref: "https://files.example.com/result.txt",
      baseUrl: "https://claude.ai/chat/example",
      ariaLabel: "Download result",
    });
    assert.ok(source);
    await logic.transferAsset(source, 1024, new AbortController().signal, {
      start: async () => undefined,
      chunk: async () => undefined,
    });
    assert.equal(credentials, "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// BB-AUD-04 / EX-AUD-04. One table, identical bytes in both repositories, each pinning its
// digest so a rule cannot be relaxed on one side alone. Only rules both sides share are
// listed; path handling differs by design and is asserted separately in each repository.
const SHARED_ASSET_NAME_FIXTURE_SHA256 =
  "a83ffececdd6bb578dc4bd7d40fe2ca2c9029e6bc048fe60e8883c9807dd032c";

const assetNameFixturePath = new URL("../protocol/asset-name.fixtures.json", import.meta.url);

test("the shared asset-name fixture table cannot drift on one side", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const bytes = await readFile(assetNameFixturePath);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    SHARED_ASSET_NAME_FIXTURE_SHA256,
  );
});

test("every shared asset-name case sanitises to its recorded result", async () => {
  const { readFile } = await import("node:fs/promises");
  const table = JSON.parse(await readFile(assetNameFixturePath, "utf8"));
  assert.equal(table.id, "bachata-asset-name-sanitation-v1");
  assert.ok(table.cases.length >= 20);
  for (const testCase of table.cases) {
    assert.equal(
      logic.sanitizeName(testCase.input, table.fallback),
      testCase.expected,
      `${testCase.name}: ${JSON.stringify(testCase.input)}`,
    );
  }
});

test("a sanitised name never ends in a dot or space and never names a device", async () => {
  const { readFile } = await import("node:fs/promises");
  const table = JSON.parse(await readFile(assetNameFixturePath, "utf8"));
  const deviceStem = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
  for (const testCase of table.cases) {
    const result = logic.sanitizeName(testCase.input, table.fallback);
    assert.equal(/[. ]$/u.test(result), false, `${testCase.name} ended in a dot or space`);
    assert.equal(deviceStem.test(result), false, `${testCase.name} still names a device`);
    assert.ok(result.length > 0, `${testCase.name} produced an empty name`);
  }
});

// BB-AUD-04 follow-up. The device prefix was added after the 180-character slice, so a long
// reserved-stem name came back at 181 characters — the exact case the cap exists for.
test("a sanitised name never exceeds the length cap, prefix included", () => {
  const limit = 180;
  for (const stem of ["CON", "com1", "LPT9", "NUL", "aux", "prn"]) {
    for (const tail of ["", ".txt", ".tar.gz"]) {
      const long = `${stem}${"a".repeat(400)}${tail}`;
      const result = logic.sanitizeName(long, "browser-asset");
      assert.ok(
        result.length <= limit,
        `${stem}${tail} produced ${String(result.length)} characters`,
      );
    }
  }
  assert.ok(logic.sanitizeName("x".repeat(500), "browser-asset").length <= limit);
});
