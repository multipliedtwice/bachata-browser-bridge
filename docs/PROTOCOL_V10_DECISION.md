# Protocol v10 decision package

Status: proposal, and specification only. Nothing here is implemented, and no test in this
repository executes any of it — the fixtures below are a corpus to write against, not a passing
suite. V2 is blocked on the owner decisions at the end of this document.

Scope: independent Markdown-fidelity and typed-activity tracks, per E5 in
[`../TODO.md`](../TODO.md). This document still describes their combined proposal. Before a
fidelity-only implementation, specify its exact contract and migration corpus; omit activity
fields and claims. No v9 wire-shape change in place. Either migration needs atomic Bridge and
Extension updates and the applicable decisions below.

## Why v10 is required

The v9 shape cannot carry either feature:

- `conversation.response.captureFormat` is the literal `"renderedText"` on both sides.
- Segment types are `text`, `codeBlock`, `quote` only.
- The controller parser rejects unknown keys outright, so an added field is refused, not ignored.
- Segments must tile `text` exactly, so a Markdown `text` with plain-text offsets fails validation.
- The contract file is byte-identical in both repositories and pinned by SHA-256 in
  `protocol/browser-bridge.compatibility.json`.

## Blocked on live evidence

Typed activity requires L1: a stable structural boundary that separates commentary from the final
answer in an authenticated ChatGPT thread. That evidence does not exist. Markdown fidelity does not
depend on it. Missing L1 blocks activity, not fidelity specification or wire-compatible work.
Fidelity migration still requires its own exact contract, compatibility and security decisions.

## Semantic blocks

`conversation.response` gains `captureFormat: "markdown"` and a block list replacing flat segments.

Block kinds, leaf only:

```text
paragraph | heading | listItem | table | code | quote | thematicBreak
```

There is no `html` block. See the injection boundary below: removing the kind is necessary but not
sufficient, because Markdown itself can carry markup and dangerous URLs.

There is no `list` block. A flat non-overlapping list cannot express containment, and a `list`
covering the same range as its items would break the coverage rule immediately. Structure travels
as fields on the item instead:

- `listKind`: `"ordered" | "unordered"`, on `listItem` only.
- `ordinal`: the rendered number, on an ordered `listItem` only.
- `depth`: 0 for a top-level item, incremented per nesting level.
- `listKey`: shared by items of the same list, so a consumer can regroup them.

A nested list is a run of `listItem` blocks with increasing `depth` and a different `listKey`. A
consumer that ignores these fields still gets correct ordered text.

Every block carries:

- `key`: stable within one response.
- `kind`.
- `markdown`: GFM source for that block.
- `text`: rendered text of that block.
- `start`, `end`: offsets into the response `text`.
- `language`: only on `code`.

Offsets are UTF-16 code units, the units `String.prototype.slice` uses and the units v9 segments
already use, so both repositories index the same string the same way with no conversion. UTF-8
bytes are used for size limits only, never as an index. Mixing the two is how an index becomes
wrong for every non-ASCII response. The coverage check itself is stated once, below.

Coverage rule, as a validator runs it. Ranges are contiguous and cover `text` completely: the first
`start` is 0, each `start` equals the previous `end`, and the last `end` equals `text.length`. A
range is its block's rendered text plus the separator that follows it, so the check is

```js
const slice = text.slice(block.start, block.end);
slice.startsWith(block.text) && /^\n*$/.test(slice.slice(block.text.length))
```

not equality. Equality and contiguity cannot both hold while separators exist, which is what the
first draft of this document got wrong. `markdown` is additive and tiles nothing.

Example, plain answer. `text` is `"Hello.\n\nDone."`, length 13:

```json
{
  "captureFormat": "markdown",
  "text": "Hello.\n\nDone.",
  "blocks": [
    { "key": "0", "kind": "paragraph", "markdown": "Hello.", "text": "Hello.", "start": 0, "end": 8 },
    { "key": "1", "kind": "paragraph", "markdown": "Done.", "text": "Done.", "start": 8, "end": 13 }
  ]
}
```

Block 0 covers `"Hello.\n\n"`; block 1 covers `"Done."`. Nothing is uncovered.

Example, GFM:

```json
{
  "key": "3",
  "kind": "code",
  "language": "ts",
  "markdown": "```ts\nconst x = 1;\n```",
  "text": "const x = 1;",
  "start": 20,
  "end": 34
}
```

## Injection boundary

Every `markdown` field is provider-controlled text. Dropping the `html` block kind removes one way
to carry markup; Markdown carries three more — raw HTML tokens, link destinations, and image
sources. The rules below are part of the contract, enforced identically in both repositories, and
they are what makes "no raw markup" true rather than aspirational.

**Producer, in the bridge.** Markdown is generated from the rendered DOM, so it is generated, not
forwarded. The generator emits no raw HTML tokens; anything a provider embedded arrives as the text
it rendered to, or as a `code` block when the page displayed it as source. Link and image
destinations are resolved and then filtered by the scheme allowlist below; a destination that fails
becomes plain text carrying the visible label, never a link.

**Parser, in both repositories.** A `markdown` field is rejected outright if it contains an HTML
tag token (`<` followed by a letter, `/`, `!` or `?`) outside a fenced or inline code span, or a
link or image destination whose scheme is not allowlisted.

**Link destinations.** Allowlist, after canonicalization:

```text
http | https | mailto
```

Everything else is rejected, including `javascript:`, `vbscript:`, `file:`, `blob:` and every
`data:` URL. Relative destinations are rejected too: the controller has no base URL that would make
them mean anything, and a scheme-relative `//host/path` is a remote fetch in disguise. A link is
never auto-followed and never prefetched; it is inert until a person clicks it.

**Image sources are not links and get their own rule.** An image is fetched by the act of
rendering, so a remote image URL is a provider-controlled network request from the controller —
a beacon that reports when a response was displayed, from which address, carrying whatever the URL
encodes. The allowlist above is therefore wrong for images:

- The only accepted image source is a bridge asset reference, and it has a grammar rather than a
  shape:

  ```text
  bachata-asset:asset-<UUID>
  ```

  `asset-<UUID>` is exactly what the bridge's asset layer already mints
  (`asset-${crypto.randomUUID()}`), matched as `asset-` followed by the canonical 8-4-4-4-12
  lowercase hexadecimal UUID form and nothing else. No path, no query, no fragment, no relative
  segments — which is what makes `bachata-asset:../escape` a rejection by the grammar and not by a
  special case.
- The reference must name an asset in the **current turn's** registry. An id that is well formed
  but was not registered for this response is rejected, so a provider cannot address another
  turn's bytes or guess at one.
- Content type is allowlisted at render:

  ```text
  image/png | image/jpeg | image/gif | image/webp
  ```

  Raster only. `image/svg+xml` is excluded deliberately: SVG is a document that can carry script
  and external references, so an SVG asset is not an image for this purpose.

  **The declared type is not the check.** Provider-supplied metadata says whatever the provider
  wants it to say, and an SVG or an HTML document claiming `image/png` would otherwise walk straight
  into the renderer. The type must be established from the bytes, and the bytes that reach the DOM
  must be the ones that survived that check.

  Validation has three parts, and they have different bounds on purpose:

  1. **Sniff** the leading bytes against the allowlisted formats — `89 50 4E 47 0D 0A 1A 0A`,
     `FF D8 FF`, `GIF87a`/`GIF89a`, and `RIFF`…`WEBP`. Anything else is rejected, whatever the
     metadata claims. Reject if the sniffed format disagrees with the declared one: a mismatch is
     not a misconfiguration to tolerate, it is a payload pretending.
  2. **Dimensions**, from the bounded parser for that format, reading only the first **1 MiB**.
     Dimensions are a prefix property — every allowlisted format states them in its first header —
     so a prefix bound is sound here.
  3. **Structural classification**: is this container animated, and how many frames does it have?
     This one may *not* use a prefix bound. A second GIF image descriptor, an APNG `acTL`, or a
     duplicate `IHDR` can sit past any prefix, and a file classified "still" on a prefix would then
     take a path it was classified out of. Classification walks real structure to a format-specific
     end point, and a container that cannot be walked to that point inside its bound is **rejected
     as undecidable** rather than assumed still.

  Then decode under the animation policy, reject if the decoded pair disagrees with the dimensions
  established in part 2, and re-encode.

  Decoded-resource limits, applied to the coded pair and to the decoded pair:

  ```text
  maximum width         8192 px
  maximum height        8192 px
  maximum total pixels  33554432 (2^25, about 33 MP)
  ```

  The pixel cap is the one that matters: 8192 × 8192 would be 268 MB of RGBA, so width and height
  alone are not a budget. An asset inside all three still decodes to at most 128 MiB, which is why
  the cap is a third limit rather than a product of the first two.

  **Classification bound.** Structural walks read up to **16 MiB** and visit up to **65536**
  structural units (PNG chunks, GIF blocks, RIFF chunks, JPEG markers). Exceeding either, running
  off the end of the data mid-structure, or passing the deadline check described under *Enforcing
  the deadline* is a rejection. Every walk advances by a length it has bounds-checked first; none
  searches raw bytes for a signature.

  **PNG and APNG.** After the 8-byte signature, chunks are `length: u32 BE` (rejected if greater
  than `2^31 - 1` or than the bytes remaining), `type: 4 bytes`, `data`, `crc: u32`.

  Structural integrity is checked by this parser, not delegated to the decoder:

  - **Every traversed chunk's CRC is verified before its contents are used.** Reading fields out of a
    chunk this parser cannot vouch for is exactly the gap between "walked the structure" and
    "validated it". The CRC is PNG's own, specified rather than named: polynomial `0x04C11DB7`, or
    `0xEDB88320` in the reflected implementations everyone actually writes; register initialised to
    all ones; computed over the **chunk type followed by the chunk data**, excluding both the length
    field and the stored CRC; finalised with a ones' complement; stored big-endian. A mismatch is a
    rejection.
  - **All four type bytes must be ASCII letters** (`A`–`Z`, `a`–`z`). Anything else is not a chunk
    type, and a walk that accepts it is following made-up lengths.
  - The **reserved bit** — bit 5 of the third type byte, which PNG requires to be zero — must be
    zero. A set bit means a chunk from a version of the format this parser does not implement.
  - **An unknown critical chunk is a rejection.** Critical is bit 5 of the first type byte being
    clear; by definition a decoder that does not understand one cannot render the file, so this
    parser must not wave it through either. Unknown *ancillary* chunks are skipped by their length,
    which is what ancillary means.
  - `IEND` must have length 0, and the datastream must end **exactly** at its CRC. Trailing bytes
    after `IEND` are a rejection, not padding.

  Then the format rules:

  - The first chunk must be `IHDR` with length 13. Coded width is the `u32` BE at file offset 16,
    height at offset 20. Zero in either is a rejection.
  - **The walk continues to `IEND`**, not to the first `IDAT`. Stopping at `IDAT` would have made
    two of this policy's own promises unenforceable: a second `IHDR` "anywhere" and an `acTL` after
    `IDAT` are both invisible to a walk that has already stopped. Reaching the bound, or the end of
    the data, without `IEND` is a rejection.
  - A second `IHDR` anywhere before `IEND` is a rejection.
  - Animation is decided at the first `IDAT` and enforced to the end: `acTL` **before** the first
    `IDAT` means APNG; an `acTL` **after** the first `IDAT` is a malformed file and a rejection,
    not an animation.
  - `acTL` data is `num_frames: u32`, `num_plays: u32`. `num_frames` of 0, or above 1024, is a
    rejection without decoding.
  - Whether the default image is part of the animation is decided by the first `fcTL`: an `fcTL`
    before the first `IDAT` makes the default image the animation's frame 0; otherwise the default
    image is a separate still and the animation's frames are the `fdAT` sequence. The animated
    track's frame 0 is what gets decoded in both cases.

  **GIF.** Header `GIF87a`/`GIF89a`, then the Logical Screen Descriptor: coded width `u16` LE at
  offset 6, height at offset 8, packed byte at offset 10, and 7 bytes in total. If the packed
  byte's global-colour-table flag (`0x80`) is set, a table of `3 × 2^((packed & 0x07) + 1)` bytes
  follows and is skipped by that computed length.

  Then blocks are walked until the trailer:

  - `0x21` extension introducer, then a label, then either a fixed block size the label defines
    (`0xF9` graphic control 4, `0x01` plain text 12, `0xFF` application 11) or a leading size byte,
    followed by **data sub-blocks**: each is a length byte, then that many bytes, ending at a
    length byte of `0x00`.
  - `0x2C` image descriptor: 9 bytes — left, top, width, height as `u16` LE, then a packed byte. If
    its local-colour-table flag (`0x80`) is set, `3 × 2^((packed & 0x07) + 1)` bytes follow. Then
    one LZW minimum-code-size byte, then data sub-blocks to a `0x00` terminator.
  - `0x3B` trailer: the walk is complete.
  - Any other block byte is a rejection.

  Only image descriptors reached this way are counted; a `0x2C` byte inside sub-block data is not a
  frame, which is the whole reason for walking rather than scanning. Two or more descriptors means
  animated; more than 1024 is a rejection without decoding. **The trailer must be reached** — a GIF
  whose structure does not terminate inside the classification bound is undecidable and rejected.
  Frame 0 must fit its canvas: `left + width ≤ screen width` and `top + height ≤ screen height`.

  **WebP.** `RIFF`, then `u32` LE size, then `WEBP`. The RIFF size must equal the file length minus
  8; a mismatch is a rejection rather than something to work around. Chunks are `FourCC`,
  `u32` LE size, payload, plus **one padding byte when the size is odd**. That padding byte must be
  present **and equal to zero**: the container specification requires it to be zero, and a nonzero
  byte there is data hiding in a slot nothing is supposed to read. A chunk whose size runs past the
  file extent is a rejection, and the last chunk must end exactly at it.

  - `VP8 ` (simple lossy): the payload's bytes 3, 4, 5 must be the keyframe start code
    `9D 01 2A`; coded width is the `u16` LE at payload offset 6 masked with `0x3FFF`, height the
    `u16` LE at offset 8 masked with `0x3FFF`. A wrong start code is a rejection.
  - `VP8L` (simple lossless): payload byte 0 must be the signature `0x2F`. Read the `u32` LE at
    payload offset 1: coded width is `(bits & 0x3FFF) + 1`, height is `((bits >> 14) & 0x3FFF) + 1`.
  - `VP8X` (extended): payload is exactly 10 bytes — flags byte, 3 reserved, canvas width minus one
    as 24-bit LE, canvas height minus one as 24-bit LE. Coded width is that value plus 1, likewise
    height. A second `VP8X`, or a `VP8X` that is not the first chunk, is a rejection.
  - Classification: the `ANIM` flag is `0x02` in the `VP8X` flags byte. **`ANIM` carries a
    background colour and a loop count, and no frame count at all** — frames are separate `ANMF`
    chunks, so the count is the number of `ANMF` chunks the walk visits. More than 1024 is a
    rejection. `ANIM.loop_count` is never read as a frame count.
  - The walk must reach the end of the RIFF extent; anything less is undecidable and rejected.

  **JPEG.** From the first two bytes, the walk is a state machine over markers, not bytes. It runs
  in a single state — *before SOF* — and every byte it meets is either a legal header construct or a
  rejection.

  - The data must begin with exactly one `SOI` (`FFD8`). A second `SOI` anywhere before SOF is a
    rejection.
  - A marker is one or more `FF` **fill bytes** followed by a type byte; fill bytes are legal and
    skipped.
  - Before SOF these are all rejections, because none of them can legally appear there: `FF00`
    (a stuffed data byte, which only exists inside entropy-coded data after `SOS`), `RST0`–`RST7`
    (`FFD0`–`FFD7`, likewise entropy-coded data), a second `SOI`, `EOI` (`FFD9`), and `SOS`
    (`FFDA`) itself. `TEM` (`FF01`) is rejected with them: it is a standalone marker with no place
    in a header.
  - **Hierarchical JPEG is rejected before any SOF is read.** `DHP` (`FFDE`) states the completed
    image's dimensions for a hierarchical sequence, and the frame headers that follow describe
    smaller stages of it — so a first SOF can be tiny while the decoder allocates for the far larger
    DHP canvas. `DHP` before SOF is therefore a rejection, as is `EXP` (`FFDF`), which only appears
    inside such a sequence.
  - **Only non-differential frame headers are accepted**: `SOF0`–`SOF3` (`FFC0`–`FFC3`) and
    `SOF9`–`SOF11` (`FFC9`–`FFCB`). The differential markers `SOF5`–`SOF7` (`FFC5`–`FFC7`) and
    `SOF13`–`SOF15` (`FFCD`–`FFCF`) are rejected: a differential frame is a stage of a hierarchical
    image, and its dimensions are not the image's. `FFC4` (DHT), `FFC8` (JPG) and `FFCC` (DAC) are
    not frame headers and are ordinary length-bearing segments.
  - Every other marker before SOF is a length-bearing segment: a `u16` BE length that includes its
    own 2 bytes, so a length below 2 is a rejection, as is one that runs past the data. The walk
    skips by that length without reading the segment's contents.
  - At the SOF, from its `FF` byte: length `Lf` at +2, sample precision at +4, coded **height**
    `Y` as `u16` BE at **+5**, coded **width** `X` at **+7**, component count `Nf` at **+9**.
    Required: `1 ≤ Nf ≤ 255` and **`Lf === 8 + 3 × Nf`** exactly — not merely `Lf ≥ 8`, since a
    frame header's length is fully determined by its component count.
  - **`X = 0` or `Y = 0` is a rejection.** `Y = 0` is legal JPEG: the real height arrives later in a
    `DNL` segment after the first scan. That is precisely a way to defeat a pre-decode allocation
    cap — the header would claim nothing and the decoder would allocate whatever `DNL` says — so
    DNL-dependent height is refused outright rather than resolved.
  - The walk **stops at the first SOF**, so it makes no claim about markers after it. An earlier
    draft promised to reject a second SOF; a walk that has already stopped cannot see one, and the
    promise is withdrawn rather than left unenforceable. What it is replaced by is stronger: the
    only legal way a JPEG carries several frame headers is a hierarchical sequence, and both of that
    sequence's markers — `DHP` and the differential SOFs — are rejected above, before any of it is
    reached.
  - Reaching the classification bound with no SOF is a rejection.
  - JPEG is never animated for this policy; MJPEG in a JPEG container is not an allowlisted type.

  **Animation geometry and frame structure.** The canvas limits bound the canvas, and a frame is not
  the canvas: APNG `fcTL` and WebP `ANMF` declare their own rectangles, and a nested bitstream inside
  an animation frame declares its own dimensions again. Each is validated structurally, before any
  decode.

  **APNG.** Exactly one `acTL`, length exactly 8. Every `fcTL` has length exactly 26 —
  `sequence_number` `u32`, `width` `u32`, `height` `u32`, `x_offset` `u32`, `y_offset` `u32`,
  `delay_num` `u16`, `delay_den` `u16`, `dispose_op` `u8`, `blend_op` `u8`.

  - `dispose_op` must be 0, 1 or 2; `blend_op` must be 0 or 1. Any other value is a rejection.
  - Sequence numbers across `fcTL` and `fdAT` start at 0 and increase by exactly 1; a gap or repeat
    is a rejection.
  - The number of frame `fcTL` chunks must equal `acTL.num_frames`.
  - Every frame needs nonzero `width` and `height`, and must sit inside the `IHDR` canvas:
    `x_offset + width ≤ IHDR width` and `y_offset + height ≤ IHDR height`.
  - **A default image that is part of the animation is the whole canvas.** When the first `fcTL`
    precedes `IDAT`, that frame's `width` and `height` must equal the `IHDR` dimensions and both
    offsets must be zero. APNG requires it, and a smaller or offset first frame would otherwise
    describe a picture the `IDAT` does not contain.
  - **All `IDAT` chunks must be consecutive.** An `IDAT` appearing after any other chunk type has
    already followed the first `IDAT` run is a rejection, not a second image.
  - **Frame controls must own frame data.** A `fcTL` is followed by the data of its own frame before
    the next `fcTL` or `IEND`; a `fcTL` with nothing after it is an empty frame and a rejection.
    - If the first `fcTL` precedes the first `IDAT`, the default image is frame 0 and its data is
      the `IDAT` run. `IDAT` is frame data for that first frame only.
    - Every later frame, and every frame of a file whose first `fcTL` follows `IDAT`, is carried by
      one or more `fdAT` chunks.
  - `fdAT` length must be at least 4 — its first four bytes are the sequence number, so a shorter
    chunk carries no frame data at all.
  - An `fdAT` with no active preceding `fcTL` is a rejection.

  **GIF.** Every image descriptor — not only frame 0 — needs nonzero width and height and must sit
  inside the logical screen: `left + width ≤ screen width` and `top + height ≤ screen height`.

  **WebP.** The container's animation parts have an exact relationship, and every one of them is
  checked:

  - `VP8X` is the first chunk, exactly 10 bytes. **Every reserved bit must be zero**: the two high
    bits of the flags byte, the low reserved bit of that byte, and all 24 bits of the three reserved
    bytes. A file that sets a bit nobody defines is a file this parser cannot claim to understand.
  - The `ANIM` flag (`0x02`) set means **exactly one** `ANIM` chunk, of exactly 6 bytes, before the
    first `ANMF`. `ANIM` absent with the flag set, a second `ANIM`, or an `ANIM` without the flag,
    are all rejections.
  - **An `ANMF` chunk with the animation flag unset is a rejection.** Frames without a declared
    animation are a container disagreeing with itself.
  - Every `ANMF` payload begins with 16 bytes: `frame_x` and `frame_y` as 24-bit LE values in units
    of 2 pixels, `frame_width − 1` and `frame_height − 1` as 24-bit LE, `duration` 24-bit LE, then a
    flags byte whose reserved bits must be zero.
  - Every frame rectangle must sit inside the `VP8X` canvas:
    `2 × frame_x + frame_width ≤ canvas width` and `2 × frame_y + frame_height ≤ canvas height`,
    with nonzero width and height.
  - **The rest of every `ANMF` payload is a nested RIFF walk**, bounded by that payload and by the
    classification bound, with the same rules as the outer one: each sub-chunk is a FourCC, a `u32`
    LE size, a payload, and a zero pad byte when the size is odd. A sub-chunk running past the
    `ANMF` payload is a rejection, and the walk must end exactly at its end.
  - Inside each `ANMF`, **exactly one** `VP8 ` or `VP8L` bitstream. Zero is a frame with no picture;
    two is a file where this parser and the decoder can pick different data, which is the whole
    reason uniqueness is checked rather than assumed.
  - **At most one `ALPH`**, and only before a `VP8 `. An `ALPH` after the bitstream, a second `ALPH`,
    or an `ALPH` alongside `VP8L` — which carries its own alpha — is a rejection.
  - **`ALPH` is validated, not merely counted.** Its payload must be at least one byte, so its
    header byte exists; that byte's two reserved bits must be zero; its compression method must be a
    defined value (0 for uncompressed, 1 for lossless-compressed); and its filtering and
    pre-processing fields must be inside their defined ranges.
  - **For compression method 0 the alpha payload has an exact length**: the bytes after the header
    byte must number exactly `frame_width × frame_height`, one per pixel. One byte short is a
    truncated plane, one byte long is data the format has no place for, and both are rejections. The
    product is computed overflow-safely — the frame rectangle is already bounded by the canvas caps,
    so the multiplication is checked against the remaining payload rather than performed blind.
  - For compression method 1 the alpha is a lossless-compressed stream whose dimensions are implicit
    in the frame, so there is no nested dimension header to check and none is expected. Its size is
    bounded by the `ANMF` payload and its decode by the same deadline as everything else.
  - **Reconstruction chunks must appear in order**: `ALPH` before its bitstream, the bitstream last
    among the chunks that build the picture. **Unknown nested chunks are tolerated only after the
    bitstream**; an unknown FourCC before it is a rejection, because a decoder that understands it
    would reconstruct a different picture than this parser measured.
  - Each nested bitstream is parsed by the same signature and dimension rules as a standalone one:
    `VP8 ` needs the `9D 01 2A` start code, `VP8L` needs the `0x2F` signature.
  - **Every frame's bitstream dimensions must equal that frame's `ANMF` rectangle** — not only
    frame 0. A later frame that disagrees is a picture the canvas never accounted for.

  **Orientation, without predicting it.** PNG has `eXIf` and WebP has an `EXIF` chunk, so no
  format-specific orientation parse would be complete, and predicting what a decoder honours is a
  guess this document should not make. The rule is stated over what comes out instead:

  - **Decoded dimensions are `VideoFrame.displayWidth` and `VideoFrame.displayHeight`** — the pair
    the frame presents after its `rotation` and `flip`, not `codedWidth`/`codedHeight`.
  - The decoded pair must equal **either** the coded pair from the header parser **or** its exact
    transpose. Anything else is a rejection.
  - The limits are applied to the coded pair before decoding and to the decoded pair after. The
    transpose needs no separate check: both a side limit and a pixel product are symmetric in width
    and height, so a transpose can never pass or fail differently from the pair it came from.
  - No orientation metadata is parsed, in any format.

  **Track selection.** `preferAnimation` decides which track `ImageDecoder` selects, and getting it
  backwards means decoding the wrong image:

  - For a container classified **still**, construct with `preferAnimation: false`.
  - For a container classified **animated**, construct with `preferAnimation: true`.
  - `await decoder.tracks.ready`, then check `decoder.tracks.selectedTrack`: its `animated` must
    match the structural classification, and its `frameCount` must equal the count the walk produced
    (`acTL.num_frames`, GIF image descriptors, WebP `ANMF` chunks). A disagreement between the
    container this policy parsed and the track the decoder selected means one of them is wrong about
    the file, and that is a rejection, not something to average out.
  - **An animation-marked container with fewer than two structural frames is rejected outright**,
    before any decoder is constructed. `ImageTrack.animated` is defined as "more than one frame", so
    no track can ever be both `animated === true` and `frameCount === 1`; an earlier draft required
    exactly that pair for a one-frame APNG, which is unsatisfiable. Rather than special-casing a
    per-format guess about which track such a file would present, the file is refused: an APNG whose
    `acTL.num_frames` is 1, or a WebP with `ANIM` and a single `ANMF`, is a container marked as an
    animation that is not one. That is a malformed shape, and the cost of refusing it — a
    single-frame animation renders as alt text instead of a picture — is smaller than the cost of
    guessing which track a decoder hands back.
  - `acTL.num_frames` of 0 is likewise a rejection, as it always was.
  - Then `decode({ frameIndex: 0, completeFramesOnly: true })`.
  - **The `createImageBitmap` fallback is permitted only for containers proven still.** It cannot
    distinguish an animation's frame 0 from a separate default image, so for an animated container
    there is no way to know which picture it returned. An animated container with no `ImageDecoder`
    available is rejected.

  **The deadline, and where it starts.** A timer cannot interrupt a synchronous structure walk or a
  synchronous encode, and a deadline that starts at worker construction misses everything before it:

  - **The absolute deadline is created when the request enters the queue**, and the parent's timer
    starts there. It runs from enqueue through the **committed render-group handoff**: queue wait,
    source acquisition, worker construction, both transfers, the walks, the decode, the re-encode,
    Blob construction, URL and reference setup, and `src` assignment.
  - What is **outside** it: the image's own `load` or `error`. That is the renderer's work, not this
    pipeline's, and it is governed by `RASTER_SETTLE_TIMEOUT_MS` instead.
  - The deadline therefore ends at the **committed handoff**, not when validated bytes first reach
    the parent — bytes in hand are not yet a rendered picture, and the URL, references, timers and
    `src` assignment that make them one are inside the budget.
  - The source fetch receives that abort signal and the remaining time; a fetch that outlives the
    deadline is aborted rather than awaited.
  - Before constructing the worker, and again before transferring the input, the parent checks that
    time remains. No time left means rejection right there — no worker, no transfer.
  - **The parent never compares its own `performance.now()` with the worker's.** A worker has its
    own time origin, so the two clocks measure from different zeros and subtracting one from the
    other is meaningless. Instead, immediately before the input transfer the parent computes
    `remainingMs` in its own clock and sends that number; the worker sets
    `localDeadline = performance.now() + remainingMs` in *its* clock and checks against that at each
    structural unit.
  - The parent's timer stays authoritative. At the original deadline it terminates the worker,
    whatever the worker believes about its own clock.
  - The decode is additionally cancelled through `ImageDecoder.close()`, since `decode()` takes no
    `AbortSignal` and `close()` is what rejects pending work.
  - The **2-second budget** is the whole of it, from enqueue to the committed handoff.

  **Cleanup, cooperative and forced.** These are two different mechanisms and the earlier draft
  treated them as one:

  - **Cooperative** cleanup runs when the worker finishes or fails on its own terms: `VideoFrame` or
    `ImageBitmap` closed once it has been drawn, the canvas **retained until the encode settles** —
    an asynchronous encoder is still reading it, so releasing it when encoding starts would be
    releasing it mid-read — then reset and dropped, and `ImageDecoder.close()` in a `finally`.
  - **Forced** termination is `worker.terminate()`, and it runs no `finally` in the worker. Nothing
    inside is guaranteed to execute. What releases those resources is the destruction of the worker
    realm itself, which is why every worker-side resource must be reachable only from that realm.
  - The parent's own cleanup is unconditional, and it releases **what the job still owns**: the
    worker reference, the worker-source URL, the deadline timer, the fetch state, the listeners,
    and any reservation not yet handed over — on success, rejection, deadline, cancellation and
    error alike. It does not touch the render group. On success the Blob, the shared PNG URL, the
    pending-byte charge and the consumers' settle timers have already moved there, and revoking
    them here would destroy the picture the job just produced.
  **What concurrency one bounds, and what it does not.** It bounds concurrent *jobs*. It is not a
  memory bound. A single job owns several representations of the same picture at once, and two of
  them outlive the job entirely:

  ```text
  source bytes            parent, then transferred into the worker
  decoded frame/bitmap    worker, from ImageDecoder
  canvas                  worker, held until the encode settles
  encoder state + output  worker, the PNG being produced
  parent ArrayBuffer      parent, from the transfer until disposal — gone before commit
  parent Blob             parent, until no consumer owns a loading reference — outlives the job
  DOM-decoded surface     the renderer's own decode, alive as long as the <img> is — outlives it too
  ```

  The last two are why serializing decodes proves nothing about totals: a response may carry up to
  100 assets (`browserAssetMetadataLimits.assetsPerResponse` in the controller) and a document may
  remember up to 128 asset sources (`maximumRememberedAssetSources` in the bridge).

  **Budgets.** Seven limits are needed. None follows from anything already in the system, so they are
  named here and left to the owner rather than picked:

  ```text
  RASTER_SOURCE_MAX_BYTES        largest asset accepted for raster validation
  RASTER_OUTPUT_MAX_BYTES        largest re-encoded PNG accepted back from one worker
  RASTER_PENDING_OUTPUT_BYTES    all validated PNG bytes held by the parent, across jobs: during
                                 handoff both copies, afterwards the Blob until no consumer owns a
                                 loading reference
  RASTER_QUEUE_MAX_JOBS          queue depth before further requests are refused
  RASTER_LIVE_MAX_PIXELS         decoded surface kept alive in the DOM, controller-wide
  RASTER_SETTLE_TIMEOUT_MS       how long one image may wait for load or error before it is given up
  RASTER_DISPOSAL_START_TIMEOUT_MS   how long a disposal worker may take to report dispose.ready
  ```

  `RASTER_OUTPUT_MAX_BYTES` is per image; `RASTER_PENDING_OUTPUT_BYTES` is the sum across every job
  whose bytes the parent still holds. One bounds a picture, the other bounds a gallery.

  What constrains them, and does not determine them: an asset transfer is already bounded by the
  `maxBytes` the controller states per fetch; a document's inline asset cache is bounded at 64 MiB
  (`maximumRememberedInlineAssetBytes`); one bridge message is bounded at 80 MiB; a validated image
  is bounded at 2^25 pixels. None of that sets a pending-output ceiling, a live-surface ceiling, or
  a settle timeout, and none of it bounds a disposal worker's startup. Until the owner sets all
  seven, V1 stays blocked; a specification that quietly
  chose them would be inventing the safety margin it claims to have.

  **Queue rules.**

  - Depth is bounded by `RASTER_QUEUE_MAX_JOBS`; beyond it, further requests are refused
    immediately rather than queued.
  - The queue holds **identifiers and small metadata only** — asset id, declared type, response id,
    the frozen consumer set, and the absolute deadline created at enqueue. No asset bytes are
    fetched or retained while a job waits.
  - On dequeue the deadline is checked **before** anything is fetched. An expired entry is rejected
    there: no fetch, no worker.
  - **Validation is deduplicated by `(responseId, assetId, renderPassId)`; rendering is not.** One
    asset appearing three times in one render pass is one decode and three consumers — *Fan-out*
    below says how the one Blob and its shared URL are accounted across them.
  - When a response is disposed, its queued entries are cancelled and any running job for it is
    terminated.

  **The cost, stated correctly.** Queue wait is charged against each image's own deadline, so in a
  response with many images the later ones do not render late — **they are rejected and shown as alt
  text**. That is the trade being asked for, and it is why the budgets above are an owner decision
  rather than a detail.

  **Two owners, not one.** A job and a rendered picture have different lifetimes, and the earlier
  draft's "the parent drops every timer and URL on success" would have revoked a good image before
  anyone saw it. Ownership is split explicitly:

  ```text
  job owns          worker, worker-source URL, deadline timer, fetch state, listeners,
                    transfer references, the pending-byte reservation until handoff
  render group owns validated Blob, shared PNG URL, per-consumer settle timers,
                    the pending-byte charge, per-consumer live-pixel charges
  ```

  On a successful handoff the second set **moves** from job to render group. Job cleanup releases
  only what the job still owns; it never revokes the PNG URL and never clears a consumer's settle
  timer. Every cleanup path is idempotent: running it twice releases nothing twice.

  **Settle-once, everywhere.** Deadline, fetch abort, cancellation, worker `error`, the ready
  message, the output offer and the final result can all arrive in any order, so the outcome is
  decided by a state machine rather than by whichever callback ran:

  ```text
  queued -> fetching -> starting -> running -> output-offered -> output-transferred
         -> handing-off -> completed
         \-> cancelled        \-> failed         \-> failed          \-> failed
  ```

  `handing-off` exists because the handoff can fail: Blob construction, URL creation, reference
  registration, timer arming and `src` assignment are all fallible, and a job that called itself
  completed before them would leak a reservation nobody owns.

  - Every job carries a **unique token**. One terminal transition helper takes that token, refuses
    to act if the job is already terminal, and otherwise performs the whole terminal path once:
    terminate the worker, revoke the worker-source URL, route any parent buffer through disposal,
    remove the job's own listeners, clear the deadline timer, settle the promise — and release
    **only a reservation the job still owns**, under the one release rule. After a committed handoff
    the reservation belongs to the render group, and this helper must not touch it. A grant with no
    delivered result is settled by terminating the worker, which is the fence: the queued result can
    no longer arrive, so the reservation is released here exactly once.
  - **Precedence is decided by the clock, not by which task ran first.** A timer task and a worker
    message task come from different task sources, and the event loop makes no promise about their
    relative order — a result can be processed after `deadlineAt` while the timer task is still
    queued. So every parent callback begins with one shared `expireIfDue(job, performance.now())`:
    if `now >= deadlineAt`, it takes the deadline path there and then, whatever the timer has or has
    not done. This applies to fetch completion, worker ready, worker `error`, `output.ready`, the
    transfer result, cancellation and the handoff commit; the timer callback calls the same helper
    and is merely one more caller.
  - A result whose callback has begun after the deadline or after cancellation is never rendered,
    but its buffer is not "discarded" either: it goes through disposal, and the reservation stays
    charged until that disposal succeeds. A result whose callback had not begun when the parent gave
    up cannot arrive at all, because termination emptied the port queue.
  - If success transitions first, the deadline callback that fires afterwards finds a terminal job
    and does nothing.
  - Each consumer has its own settle-once state, independent of the job's and of the other
    consumers'.

  **Output reservation, before the bytes move — and it is two copies, not one.** The pending-output
  budget is meaningless if it is charged after the bytes are already in the parent, and a single
  `byteLength` under-counts what the parent actually holds during handoff: `new Blob([buffer])`
  **copies** the bytes, so for a moment the ArrayBuffer and the Blob both exist.

  1. The worker encodes, checks `RASTER_OUTPUT_MAX_BYTES`, and sends **metadata only**:
     `output.ready(N)`. No buffer yet.
  2. The parent **validates `N` before doing arithmetic with it**: `Number.isSafeInteger(N)`,
     `N > 0`, `N ≤ RASTER_OUTPUT_MAX_BYTES`, and `2 × N ≤ Number.MAX_SAFE_INTEGER`. A value failing
     any of these is a rejection, not a number to clamp — it did not come from a source worth
     trusting arithmetic from.
  3. The parent calls `expireIfDue`, then **atomically reserves `2 × N`** against
     `RASTER_PENDING_OUTPUT_BYTES`. Two copies is what handoff costs, so two copies is what is
     reserved. A reservation that does not fit is a refusal, and the picture becomes alt text
     without its bytes ever entering the parent.
  4. Only after the parent grants does the worker transfer the buffer.
  5. The parent verifies the transferred length equals `N`; a mismatch is a rejection, and the
     buffer goes through **disposal** below. Nothing is released until that disposal succeeds.
  6. The parent constructs the Blob, disposes the ArrayBuffer, and only then reduces the reservation
     from `2 × N` to the Blob's `N`.

  The availability cost is real and stated: an output that would fit the budget at rest can still be
  refused because its two-copy handoff does not fit.

  **Buffer disposal, one transition for every exit.** An ArrayBuffer that reached the parent is
  charged until the controller has provably let go of it. One disposal transition is used by every
  path that can be holding one — successful Blob construction, transferred-length mismatch, a result
  arriving after the deadline, a result arriving after cancellation, a worker error after transfer,
  handoff rollback, and any other callback that receives one.

  **Disposal means handing the backing store to a dedicated worker and terminating it.** Transfer
  moves the store rather than freeing it, so something must own it afterwards and be destroyed.

  1. Transfer the buffer back to the job's worker while that worker is still usable, then terminate
     it.
  2. If the job's worker is gone or unusable, construct a **disposal worker**, transfer the buffer
     into it, and terminate it.
  3. If the transfer cannot be performed at all, the still-attached buffer and its **full `2 × N`
     reservation** move to the **disposal hold**.

  `structuredClone(buffer, { transfer: [buffer] })` is **not** a disposal. It returns a new
  ArrayBuffer owning the same backing store, so dropping that clone is the reference drop this
  section forbids.

  **What "released" means, exactly.** Termination runs in parallel and reports nothing back, so this
  document does not claim the allocator has reclaimed anything. The reservation accounts for what the
  controller can still reach or control, and successful disposal is:

  1. the receiving worker has reported `dispose.ready`, so its script loaded and its port is
     entangled;
  2. `postMessage` with the buffer in the transfer list returns without throwing;
  3. the parent observes `buffer.byteLength === 0`, so nothing attached remains on this side;
  4. `terminate()` is invoked on that worker.

  After those four, the controller holds no attached buffer and the standard-mandated termination
  path owns the destruction of what it was given. **Logical** release may proceed. Anything less —
  a constructor failure, a `postMessage` that throws, a buffer still reporting a nonzero
  `byteLength` — leaves the buffer attached, and it and the full reservation move to the hold.

  **The disposal worker, concretely.** It is a worker, so it has a script, and it cannot be trusted
  before that script has loaded:

  - Its source is the **same packaged worker bundle** the validation pipeline already ships. The
    mode is the constructor's `name` option — `new Worker(url, { name: "bachata-raster-dispose" })` —
    which the bundle reads from `self.name` at startup and which selects a path that receives one
    transferred buffer and nothing else. No second bundle, no second packaging gate.
  - It is created from a Blob over that packaged source, so it depends on the same `worker-src blob:`
    and `connect-src` expansion. **Without that CSP decision there is no disposal worker**, and every
    failed-path disposal goes to the hold.
  - **The source Blob URL is retained until the worker says it is ready.** The processing model
    fetches the script first, and only on success associates the worker with its global scope and
    entangles the ports. Before that boundary there is no proof the delivery fence exists.

  **Readiness is a bounded, settle-once attempt, not a constant.** A timeout value enforces nothing
  on its own: `dispose.ready` and the timer are different tasks, and their order decides nothing.

  ```text
  starting -> ready        -> transferred -> terminated
           \-> failed      \-> failed
           \-> expired     \-> expired
  ```

  `failed` and `expired` are reachable **from `ready` as well as from `starting`**: the second clock
  check sits between readiness and transfer, and `postMessage` can throw after readiness. Every
  terminal state settles once, and any callback arriving afterwards is inert.

  Ownership per transition:

  - Failure or expiry **before** a successful transfer leaves the parent buffer attached: the buffer
    and its full `2 × N` go to the hold, and nothing is released.
  - `transferred` is reached only when `postMessage` returned and `byteLength === 0` was observed.
    From there, termination and logical release follow.
  - No path after `transferred` may put a detached buffer into the hold — there is nothing attached
    to put there.

  - `disposalDeadlineAt = performance.now() + RASTER_DISPOSAL_START_TIMEOUT_MS` is computed **before**
    the source URL is created and the worker constructed, so the whole startup attempt is inside it.
  - One `expireDisposalIfDue(attempt, performance.now())` helper is called at the top of every
    callback — the timer, the `dispose.ready` message, the worker `error`, and cancellation. If
    `now >= disposalDeadlineAt` the attempt expires there, whatever the timer task has done.
  - The clock is read **again immediately before `postMessage`**. Readiness and transfer are separate
    *steps*, not necessarily separate tasks: the transfer may run synchronously inside the ready
    callback, and the URL revocation and other synchronous work between them can still cross the
    deadline. Nothing here requires an `await` or another queued task — it requires a second reading
    of `performance.now()`.
  - The ready message has a fixed shape and is bound to that attempt:
    `{ type: "dispose.ready", attemptToken }`, where `attemptToken` is the token minted with the
    attempt. Anything else — a different token, a repeat, a wrong shape, a message after the attempt
    is terminal — is ignored, and can neither transfer nor release anything.
  - Terminal cleanup runs exactly once: clear the timer, remove the message and error listeners,
    revoke the source URL, terminate whatever worker exists.

  Ordering on the successful path:

  ```text
  compute disposalDeadlineAt
  create source Blob URL, construct worker (name selects dispose mode), URL retained
  await dispose.ready with the attempt token   -- clock checked on arrival
  revoke the source Blob URL
  clock checked again, then postMessage(buffer, [buffer])
  verify buffer.byteLength === 0
  terminate()
  release logically, once
  ```

  On expiry or any failure **before transfer**, the buffer is still attached: nothing is released,
  and the buffer with its full `2 × N` goes to the hold.

  **The disposal hold.** Owned by the controller-wide raster registry, not by any job:

  - It holds the still-attached buffer, its `2 × N` reservation, and the job token that produced it.
  - **At most one disposal attempt is active controller-wide**, and records drain in **FIFO order**
    by the time they entered the hold.
  - Concurrency against validation, locked as the reading of decision 3b: the validation queue stays
    at concurrency one, **one disposal worker may coexist with that one validation worker**, and
    never two disposal workers.

  **Scheduling: an explicit machine, not a habit.** The registry holds:

  ```text
  holds                  FIFO records, oldest first
  activeDisposalAttempt  one attempt, or none
  drainPending           boolean, a coalesced request for one later attempt
  scheduledDrainToken    unique token for one queued drain task, or none
  registryDestroyed      terminal
  ```

  `scheduledDrainToken` exists because a queued retry is real state. Without it, the window between
  "failure cleared `drainPending`" and "the queued task runs" looks idle — nonempty hold, no active
  attempt, no pending flag — so a fresh trigger starts an attempt, and the queued task then asks for
  another. A token makes that window representable and makes superseded callbacks inert.

  **Every attempt starts through `requestHoldDrain()`**, and nothing else:

  ```text
  requestHoldDrain():
    if registryDestroyed:                                  return
    if holds is empty:
        drainPending = false
        scheduledDrainToken = none                          -- nothing left to drain
        return
    if activeDisposalAttempt or scheduledDrainToken:
        drainPending = true                                 -- coalesce, do not compete
        return
    drainPending = false
    start exactly one attempt for holds.head
  ```

  Attempt completion, **success**:

  ```text
  settle the attempt once
  release and remove holds.head once
  activeDisposalAttempt = none
  if holds is empty:
      drainPending = false
      scheduledDrainToken = none
  else:
      requestHoldDrain()        -- re-enter; never start the next head directly
  ```

  Re-entering is the fix for a subtler race than it looks: a trigger that arrived while head A ran
  has already been served by A's own attempt. Starting head B directly would leave that flag set, and
  B's later failure would consume a trigger nobody sent for it, buying an extra retry out of nothing.
  `requestHoldDrain()` consumes the flag before B starts.

  Attempt completion, **failure or expiry**:

  ```text
  settle the attempt once
  keep the record at holds.head        -- returned once, not requeued at the back
  activeDisposalAttempt = none
  if not drainPending:  stop           -- no autonomous retry
  drainPending = false
  scheduledDrainToken = a fresh token
  queue one later task carrying that token
  ```

  The queued task:

  ```text
  if registryDestroyed:                 return
  if token != scheduledDrainToken:      return    -- superseded; inert
  scheduledDrainToken = none
  requestHoldDrain()
  ```

  A trigger arriving before that task runs now sees `scheduledDrainToken`, sets `drainPending`, and
  starts nothing. The task collapses everything into exactly one attempt.

  Invariants:

  - At most one `activeDisposalAttempt`, and at most one live scheduled drain task.
  - `activeDisposalAttempt` and `scheduledDrainToken` never both own a start.
  - One FIFO record belongs to at most one attempt.
  - `drainPending` is a request, never an attempt, and never on its own a reason to refuse anything.
  - A scheduled task never starts an attempt itself; it calls `requestHoldDrain()`.
  - An empty hold has no active attempt, no scheduled token, and `drainPending == false`.
  - A success never starts an attempt on an empty queue, whatever `drainPending` said.

  **Triggers.** Exactly these call `requestHoldDrain()`:

  ```text
  a validation worker is constructed
  a validation worker reports ready
  the validation queue is pumped (a job enqueued, dequeued, or completed)
  an output.ready offer arrives
  ```

  **Destruction is not a trigger.** Destroying the webview or controller sets `registryDestroyed`,
  invalidates `scheduledDrainToken`, clears `drainPending`, terminates any active worker, makes both
  active and scheduled callbacks inert, and destroys the realm together with all accounting. It
  constructs nothing: building a disposal worker while tearing the realm down would be building
  something to hold bytes that are about to cease existing anyway.

  This document does not claim the hold retries "when a worker becomes constructible" — that is not
  observable without making an attempt. It retries **on the next named trigger**, and:

  > **Availability limitation, stated plainly.** If a disposal fails, `drainPending` is false, and no
  > further controller activity occurs, the hold stays pinned until activity resumes or the realm is
  > destroyed. Its `2 × N` stays charged for that whole time. An idle controller does not heal
  > itself.

  **Admission: an output offer cannot jump the hold.** On `output.ready(N)`, `requestHoldDrain()`
  runs first and the decision is read from the settled state:

  - **Any hold record, or an active attempt, means refuse** — before any transfer is granted. That
    image renders as alt text and its buffer never enters the parent.
  - An empty hold implies no active attempt, no scheduled token and `drainPending == false`, by the
    invariants above, so neither a stale flag nor a stale token can refuse an unrelated output.
  - The offer is **not parked**: waiting behind a hold that may never drain would hold a validation
    worker and its deadline hostage to an unrelated failure.
  - It is not admitted merely because its `2 × N` would fit alongside the hold. The rule is
    occupancy, not arithmetic.
  - The refused job still follows its ordinary settle-once cleanup and deadline rules.

  This is the precise reading of 3b's "holds drain first", and it has a visible cost: **while a hold
  is stuck, every later image in every response renders as alt text**, not just the one that lost.
  That cost belongs to 3b and is named there rather than left implicit.

  Each entry's transition is idempotent and terminal-once: one that disposes successfully releases
  its reservation exactly once and is removed.

  The invariant, stated once:

  > The reservation may not be reduced or released while an attached parent buffer exists. A
  > disposal that fails before `byteLength === 0` moves the buffer and the full `2 × N` to the
  > disposal hold, which owns them until a later disposal succeeds.

  **The post-grant race, and why termination settles it.** `postMessage` serializes and transfers
  before it queues the delivery task, so a buffer can already belong to a queued task when the parent
  gives up. `Worker.terminate()` is what resolves that: the termination algorithm sets the closing
  flag, discards the worker's queued tasks, aborts its running script, and **empties the port message
  queue entangled with the worker's implicit port**. A result that had not yet begun delivery cannot
  be delivered afterwards.

  So the race has exactly two outcomes:

  - **The result callback has begun.** The parent owns the transferred buffer. It runs `expireIfDue`
    first, and an expired or cancelled job routes that buffer through disposal instead of rendering
    it.
  - **Timeout or cancellation wins first.** The parent terminates the worker, which is the fence:
    the queued result can no longer arrive. The reservation is released once through the terminal
    transition.

  Removing listeners is not the fence — termination is. Clock precedence is unchanged: a result
  callback that begins after `deadlineAt` still loses, even if its task ran before the timer's.

  **One release rule**, covering every terminal path — mismatch, cancellation, worker error,
  post-deadline result, handoff rollback, response teardown:

  ```text
  no buffer arrived, worker terminated  -> release may proceed
  buffer arrived, disposal succeeded    -> release or downgrade may proceed
  buffer arrived, disposal failed       -> ownership moves to the disposal hold; charge stays
  ```

  No terminal transition may orphan an attached buffer or its reservation.

  **The handoff is a transaction.** `output-transferred → handing-off → completed`:

  - `expireIfDue` runs before the handoff starts and again before the commit.
  - Eligible consumers reserve their live-pixel charges first. A consumer that cannot reserve
    becomes alt text on its own, without affecting the others.
  - **If no consumer remains eligible, the output is released without a render group ever existing.**
  - Blob creation, URL creation, reference registration, timer arming and `src` assignment are one
    transaction. A failure part-way rolls back once: URL revoked if created, references dropped,
    timers cleared, pixel charges released. The **byte reservation follows the one release rule**,
    not the rollback: it is released only if no parent buffer arrived or its disposal succeeded, and
    otherwise moves to the disposal hold.
  - **Reservation ownership moves to the render group only at commit.** Until then the job still
    owns it, which is what makes rollback well-defined.
  - Completion cleanup then releases only job-owned resources.

  **Source limiting is preventive, and it stops before allocation.** `RASTER_SOURCE_MAX_BYTES` is
  passed as the `maxBytes` of the existing asset fetch, which refuses a declared size above it and
  fails the transfer once accumulated decoded bytes exceed it. One gap remains in that boundary as
  written today: a chunk's Base64 payload is decoded *before* the cumulative check, so a single
  oversized chunk allocates first and is refused second. The pipeline therefore requires a check
  ahead of the decode, and that check computes the **exact** decoded length rather than a bound:

  1. Validate canonical shape first: the encoded length is nonzero and divisible by 4, every
     character is in the transport's existing Base64 alphabet, and padding is 0, 1 or 2 `=` at the
     end and nowhere else.
  2. `exactDecodedLength = (encodedLength / 4) × 3 − paddingCount`.
  3. Reject if `exactDecodedLength` exceeds the decoded capacity still permitted.
  4. Reject if `exactDecodedLength` exceeds the per-chunk transport ceiling.
  5. Only then decode, and let the existing declared-size and cumulative checks run unchanged.

  An upper bound of `3/4 × encodedLength` is not good enough here and the earlier draft was wrong to
  use one: `YQ==` is 4 characters and decodes to **one** byte, while that bound claims three. A
  chunk that fits exactly into the last remaining byte would be refused, and the specification would
  be describing a limiter that rejects valid transfers.

  **The per-chunk ceiling is an existing transport invariant, not a resource budget.** The producer
  already fixes it: `transferChunkBytes = 128 * 1024` in `src/content/assetLogic.ts`. So:

  ```text
  maximum decoded chunk    131072 bytes  (128 KiB)
  maximum encoded chunk    174764 characters, with exactly 1 padding character
  ```

  Derived, not chosen: 131072 = 3 × 43690 + 2, so 43690 full triplets give 174760 characters and the
  trailing two bytes give one more group with a single `=`. The identity holds:
  `(174764 / 4) × 3 − 1 = 131072`. A chunk claiming more encoded characters than that is refused
  before it is examined further.

  With those checks in place, an oversized source is refused **without being decoded or retained**,
  and no worker is constructed for it.

  **Fan-out: one Blob, one URL, one render pass.**

  - A **render pass** is one construction of a response's rendered output. Its consumer set is
    collected and **frozen before the job is enqueued**.
  - `renderPassId` is **minted by the controller** — never supplied, influenced or echoed by a
    provider — as one new identifier per render construction of that response. The renderer runs in
    the webview, so it uses the primitive the webview already uses: `crypto.randomUUID()`, as in
    `src/webview-ui/main.ts`. No second format is invented:

    ```text
    grammar     8-4-4-4-12 lowercase hexadecimal with hyphens, RFC 4122 version 4
    length      exactly 36 characters
    canonical   lowercase only; an uppercase or braced form is not a different spelling of the
                same id, it is invalid
    comparison  exact string equality, no normalisation step
    ```

    It is minted in a loop until the value is absent from the live pass registry — a collision is
    re-minted, never reused — and may not be reused while any job or render group from the old pass
    still exists. The pass registry entry is removed only after every job and group for it has been
    disposed. A provider-supplied value is never accepted, whatever it looks like.
  - The job key is `(responseId, assetId, renderPassId)`. Occurrences are deduplicated **inside that
    frozen pass**: one asset mentioned three times in one pass is one validation job and three
    consumers.
  - A later render pass of the same response and asset is a **different key**, so it gets its own
    job and its own render group. It cannot collide with the earlier job, and it cannot join the
    earlier group — which is what the previous "a late occurrence is a new request" line implied
    without a key that could express it.
  - Nothing caches a validated output across passes. A cache would be retained bytes outside every
    budget named here, and no budget for it has been chosen.
  - One validated Blob and **one reference-counted shared PNG object URL** per job. The URL is
    created inside the handoff transaction, after the exact reservation succeeded.

  **Consumer lifecycle: two resources, two lifetimes.** An `<img>` holds two different things, and
  they do not end together:

  ```text
  awaiting-load -> loaded -> removed
               \-> error
               \-> removing-before-load(reason) -> removed-before-load
  ```

  `reason` is one of **DOM removal**, **settle timeout**, or **response teardown**. There is no
  direct `timed-out` terminal edge: a timeout is a removal like any other, and it releases nothing in
  its own callback stack.

  - A consumer owns a **loading reference** to the shared URL while it is in `awaiting-load` **or**
    `removing-before-load`. Leaving `awaiting-load` is not leaving the loading set: a removal still
    holds its reference until its post-image-update continuation runs.
  - The shared URL is revoked, the Blob dropped and the pending-byte reservation released **only when
    no consumer owns a loading reference** — the predicate is the reference count.
  - The **live-pixel charge does not end at `load`.** It is held until the element is removed from
    the DOM or the response is torn down, and on the removal paths it is released last, in the
    continuation.
  - `error` may end directly: the provider already produced an error event, so there is no in-flight
    request to abort and nothing to defer for. Timeout is not the same thing and does not share its
    rule.

  **Each rendered image is a standalone `<img>`.** The removal path depends on removing `src`
  selecting a null image source, which happens only when nothing else can supply one. So every
  renderer-created image is a fresh `<img>` created for one consumer, never inside a `<picture>`,
  never given `srcset`, never associated with a `<source>`, carrying the shared PNG object URL in
  `src` and nothing else. An image that does not satisfy this is not a consumer of this pipeline.

  **Removal before load is a sequence, not an assumption.** A `load` task can already be queued when
  removal starts, a decode can be in flight, and removing `src` aborts nothing synchronously: it
  queues the "update the image data" step, and that step is where the platform aborts the current and
  pending requests, forgets the image data, and discards pending fetch tasks.

  The **resource** part of the sequence is identical for every reason. The **DOM** part is not, since
  an element that is already disconnected has no insertion point and a response being destroyed has
  nowhere worth writing to.

  In the mutation's own stack, common to all reasons:

  1. Claim `removing-before-load` through the consumer's settle-once state, with its reason. A `load`
     or `error` task already queued finds the consumer non-`awaiting-load` and commits no second
     outcome. **Nothing is released here** — not the loading reference, not the pixel charge.
  2. Do the reason's DOM step, below.
  3. Remove the `src` attribute from the retained element. With no `srcset`, no `<picture>` and no
     associated `<source>`, that selects a null image source.
  4. Keep the loading reference, the pixel charge, the listeners, the timer and the cleanup record.
  5. Schedule the continuation **after** the image-update microtask the mutation queued.

  The DOM step, by reason:

  - **Settle timeout, element still connected.** Capture `parentNode` and `nextSibling` *before*
    touching anything, then replace the element with the plain-text fallback at that captured
    position. `replaceWith` on an already-disconnected element does nothing, which is why the
    position is captured first.
  - **Controller-initiated removal, element still connected.** A fallback **is** required — the
    reader asked for a picture and gets an explanation instead of a gap. Same capture-then-replace,
    same ordering.
  - **Element observed already disconnected.** There is no parent and no insertion point, so **no
    fallback is inserted**. Clear `src` on the retained element and run the deferred cleanup. The
    alt text is the responsibility of whoever disconnected it.
  - **Response teardown.** No fallback: the response is being destroyed, and writing text into it is
    writing into something nobody will read. Disconnect if still connected, clear the source, and let
    the registry-owned records run to group finalisation.

  In the continuation, common to all reasons:

  6. Remove the `load` and `error` listeners, clear the settle timer, drop the element reference.
  7. Decrement the shared loading reference.
  8. Release the pixel charge last.
  9. If any consumer still owns a loading reference, the shared URL, the Blob and the pending-byte
     reservation stay.

  **The fallback is inserted as text, never as markup.** Alt text is provider-controlled: it arrives
  in the Markdown the model wrote. It is inserted with `document.createTextNode(altText)` or an
  equivalent `textContent` assignment, and **never** through `innerHTML`, `insertAdjacentHTML`,
  `DOMParser`, or by handing it back to the Markdown renderer. Text that looks like markup —
  `<script>alert(1)</script>`, `<img onerror=alert(1)>` — is displayed as those characters, because
  that is what it is. The existing per-item length bound still applies.

  **Cleanup records and group ownership.** A continuation must be able to reach the shared resources
  it will decrement, and a teardown must not destroy what owns it. So:

  - Entering `removing-before-load` registers a **cleanup record** in the controller-wide raster
    registry: `consumerToken`, `renderGroupId`, the element, its listeners, its timer, and flags for
    the loading reference and pixel charge it still owns.
  - A render group is never destroyed while records reference it. Response teardown marks the group
    **`tearing-down`** and starts or preserves its registry-owned records; the registry keeps the
    group reachable by `renderGroupId` until the last record finishes.
  - Each continuation looks the group up by that id, decrements exactly once, and removes its own
    record. The release that takes the loading count to zero revokes the URL, drops the Blob and
    releases the pending bytes. The last record removed permits the group's final deletion.
  - **A record referencing a group that does not exist is an invariant breach, not a case to
    tolerate.** The registry keeps the group reachable for exactly as long as any record names it,
    so a failed lookup means the registry's own bookkeeping is wrong. Silently dropping the record
    would strand its charges with no owner and no retry; keeping the record with no group would
    create a second competing owner. Neither is acceptable, so the response is terminal: fail the
    turn, and destroy the renderer realm through the same final-cleanup boundary that ends a webview.
    That destruction is what clears the accounting, because it is the only thing that provably ends
    every reference at once. The two post-job owners are unchanged: render group and disposal hold.
  - Repeated teardown or repeated continuation cannot double-release: both are terminal-once on the
    record.

  What this claims is a **logical** transition — the element is out of the document, has no source,
  its requests are aborted, its image data is forgotten, and nothing the controller owns still
  references it. It does not claim the allocator has reclaimed anything at that instant.

  **Worker-source URL.** Job-owned, and nothing to do with the PNG URL. Created from the packaged
  worker bundle, revoked once the worker reports ready — and also on constructor failure, on worker
  `error`, on the deadline, on cancellation, and on any termination before ready. A worker that never
  reports ready must not leave its source URL behind.

  **Settlement is bounded.** If neither `load` nor `error` fires within `RASTER_SETTLE_TIMEOUT_MS`,
  the consumer enters `removing-before-load` with reason *settle timeout* — the same deferred
  sequence as any other removal, releasing nothing in the timer's own stack and releasing both
  charges only in the post-image-update continuation. This timeout is outside the pipeline's 2-second
  deadline: the deadline ends at the committed handoff, and what follows belongs to the renderer.

  **Worker deployment contract.** The worker this policy depends on cannot run under the
  controller's current webview policy, and saying "run it in a worker" without saying that would be
  specifying something that does not start.

  The controller's webview sends this today (`extension/src/webview/html.ts`):

  ```text
  default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource};
  style-src ${webview.cspSource}; script-src 'nonce-${scriptNonce}';
  ```

  There is no `worker-src`, so worker creation falls back to `script-src`, which permits exactly one
  thing: scripts carrying the document nonce. A `blob:` worker is denied. A VS Code webview cannot
  load a worker from an `https://…vscode-resource` URL either; it needs a `blob:` or `data:` worker,
  and that worker must be one self-contained file, because a blob worker has no base URL to resolve
  imports against.

  So the contract is:

  - **One packaged worker bundle**, built as a single file with no `importScripts` and no dynamic
    `import`. Everything the validation needs is inside it.
  - The webview **fetches the packaged source** through its own `vscode-resource` URI — a script
    fetch, which `default-src 'none'` already forbids, so `connect-src ${webview.cspSource}` is part
    of the expansion — and constructs the worker from a blob over those bytes.
  - **CSP expansion, minimal**: add `worker-src blob:` and `connect-src ${webview.cspSource}`.
    Nothing else changes; `img-src` already allows `blob:`, which is what the rendered PNG needs.
  - **Gates**, matching how every other packaged asset is already held in place:
    - the bundle is added to the VSIX required-entry list in `tests/vsixVerification.test.cjs`,
      beside `dist/webview.js` and the vendored assets;
    - it is added to the source-distribution and package allowlists;
    - a CSP gate asserts the served header contains `worker-src blob:` and still contains no
      `unsafe-inline` or `unsafe-eval`;
    - a worker-boot gate asserts the packaged bundle constructs, reports ready, and answers a
      round-trip message — so a bundle that ships but cannot start is a failing gate rather than an
      image that never renders.
  - **Worker source lifecycle**: the blob URL for the worker source is revoked once the worker
    reports ready. It is a different resource from the PNG blob URL and is never confused with it.

  **This CSP expansion is an owner security decision.** `worker-src blob:` lets the webview run code
  from bytes it assembled itself, and `connect-src` lets it fetch its own packaged files. Both are
  narrow, and neither loosens `script-src`, but they widen the webview's trust boundary and belong
  to the owner, not to this document. Until it is approved, the raster pipeline has no place to run
  and V1 stays blocked on it.

  **Re-encode before rendering.** The decoded frame is rasterized **as displayed** — its `rotation`
  and `flip` applied — and that raster is encoded to PNG, which is what reaches the DOM. Copying the
  coded plane and dropping the orientation would silently rotate the picture, so the re-encode is
  defined over the displayed orientation, matching the `displayWidth`/`displayHeight` pair the
  limits were checked against. The original container never reaches the DOM: rendering the validated
  bytes "with the sniffed type" would still hand it to a second decoder, and a format-specific bug
  in that decoder is exactly what the validation was standing in front of.

  An asset that fails any step renders as its alt text, exactly like a rejected destination.

  Fixtures for the raster path:

  ```text
  accept  16x16 PNG, declared image/png, registered this turn
  accept  1x1 GIF, declared image/gif                         (single descriptor, still)
  accept  4000x3000 JPEG decoding to displayWidth 3000, displayHeight 4000  (exact transpose)
  accept  4000x3000 JPEG with rotation 90 and flip            (PNG holds the displayed raster)
  accept  JPEG with a progressive SOF2                        (non-differential frame header)
  accept  64x64 animated GIF, two descriptors                 (animated track, frame 0)
  accept  64x64 APNG, acTL num_frames 8, fcTL before IDAT     (default image is frame 0)
  accept  64x64 APNG, acTL num_frames 8, fcTL after IDAT      (separate default image; animated
                                                               track's frame 0 is decoded)
  accept  64x64 animated WebP, VP8X ANIM, 12 ANMF chunks      (animated track, frame 0)
  accept  PNG carrying an eXIf chunk                          (metadata unparsed; decoded pair rules)
  accept  WebP carrying an EXIF chunk                         (same)
  accept  JPEG with legal FF fill bytes before a segment      (fill bytes are skipped)
  accept  WebP with an odd-sized chunk and a zero pad byte    (padding present and zero)

  reject  SVG bytes declared image/png                        (sniff disagrees with metadata)
  reject  HTML bytes declared image/png                       (sniff matches nothing allowlisted)
  reject  PNG header declaring 100000x100000                  (over both side limits)
  reject  PNG header declaring 6000x6000                      (sides inside 8192, 36M px over 2^25)
  reject  PNG header declaring 8000x5000                      (sides inside 8192, 40M px over 2^25)
  reject  PNG whose header says 16x16 and displays 4096x4096  (neither coded nor transpose)
  reject  JPEG 4000x3000 displaying 3000x3000                 (not the coded pair or its transpose)
  reject  truncated PNG that fails to decode                  (no decoder accepts it)
  reject  PNG with a second IHDR before IEND                  (duplicate header)
  reject  PNG with a second IHDR after the first IDAT         (walk continues past IDAT to catch it)
  reject  PNG with no IEND inside the classification bound    (walk never reached its end point)
  reject  APNG whose acTL sits after a 4 MiB iTXt but before IDAT  (animated past any prefix bound)
  reject  APNG whose acTL sits after the first IDAT           (malformed, not an animation)
  reject  APNG with acTL num_frames 100000                    (declared frame count over 1024)
  reject  APNG with acTL num_frames 0                         (an animation with no frames)
  reject  APNG with acTL num_frames 1                         (animation-marked, fewer than two
                                                               frames; no track can be animated
                                                               with frameCount 1)
  reject  APNG with two acTL chunks                           (exactly one is allowed)
  reject  APNG whose acTL length is not 8                     (malformed control chunk)
  reject  APNG whose fcTL length is not 26                    (malformed frame control)
  reject  APNG whose fcTL sequence numbers skip a value       (sequence must increase by one)
  reject  APNG with 8 fcTL chunks and acTL num_frames 9       (count disagrees with structure)
  reject  APNG frame with zero width                          (empty frame rectangle)
  reject  APNG frame whose x_offset + width exceeds IHDR      (frame outside the canvas)
  reject  GIF whose second image descriptor sits past 1 MiB   (animated past any prefix bound)
  reject  GIF with 1025 image descriptors                     (counted frames over 1024)
  reject  GIF with no trailer inside the classification bound (undecidable, not assumed still)
  reject  GIF whose frame 0 exceeds its logical screen        (frame outside the canvas)
  reject  GIF whose third descriptor exceeds the logical screen   (every frame is checked)
  reject  GIF descriptor with zero height                     (empty frame rectangle)
  reject  WebP with 1025 ANMF chunks                          (counted frames over 1024)
  reject  WebP with VP8X ANIM and a single ANMF chunk         (animation-marked, fewer than two
                                                               frames)
  reject  WebP whose ANIM loop_count is 50000 with one ANMF   (loop count is not a frame count, and
                                                               one frame is not an animation)
  reject  WebP whose ANIM chunk is not 6 bytes                (malformed animation header)
  reject  WebP whose ANMF payload is under 16 bytes           (frame header truncated)
  reject  WebP ANMF rectangle exceeding the VP8X canvas       (frame outside the canvas)
  reject  WebP frame 0 whose nested VP8L dimensions disagree with its ANMF rectangle
  reject  WebP with a second VP8X chunk                       (duplicate header)
  reject  WebP whose RIFF size disagrees with the file length (container extent mismatch)
  reject  WebP with an odd-sized chunk and no pad byte        (padding absent)
  reject  WebP with an odd-sized chunk and a 0x01 pad byte    (padding must be zero)
  reject  VP8 chunk without the 9D 01 2A start code           (not a keyframe)
  reject  VP8L chunk whose first byte is not 0x2F             (missing signature)
  reject  JPEG whose SOF lies beyond the 1 MiB dimension window
  reject  JPEG SOF with Y = 0                                 (height deferred to DNL)
  reject  JPEG SOF with X = 0                                 (zero width)
  reject  JPEG SOF with Nf = 3 and Lf = 11                    (Lf must equal 8 + 3 x Nf, i.e. 17)
  reject  JPEG SOF with Nf = 0                                (no components)
  reject  JPEG with DHP before SOF, DHP canvas 20000x20000, first SOF 64x64
                                                              (hierarchical: the frame header is not
                                                               the completed image's size)
  reject  JPEG with a differential SOF5                       (stage of a hierarchical image)
  reject  JPEG with a differential SOF13                      (same)
  reject  JPEG with an EXP marker before SOF                  (hierarchical construct)
  reject  JPEG segment whose declared length is below 2       (impossible segment)
  reject  JPEG with FF00 before SOF                           (stuffed byte outside entropy data)
  reject  JPEG with an RST marker before SOF                  (entropy-coded data construct)
  reject  JPEG with a second SOI before SOF                   (one SOI only)
  reject  JPEG with EOI before SOF                            (ends before it declares a frame)
  reject  JPEG with SOS before SOF                            (scan before its frame header)
  reject  animated container decoded on a still-selected track    (selected track disagrees)
  reject  animated container whose track frameCount disagrees with the counted frames
  reject  animated container with no ImageDecoder available   (createImageBitmap cannot be trusted
                                                               to return the animation's frame 0)
  reject  GIF whose structural walk exceeds 2s                (deadline during walking)
  reject  16x16 PNG whose decode exceeds 2s                   (deadline during decode)
  reject  8000x4000 PNG whose re-encode exceeds 2s            (deadline during encoding)
  reject  asset whose worker never reaches its ready message  (deadline before any work starts)
  reject  asset whose input transfer does not complete        (deadline during input handoff)
  reject  asset whose result bytes never arrive               (deadline during result handoff)
  reject  the 40th image of a response while 39 are queued    (queue wait is inside the deadline)
  reject  any raster where no boundable pipeline exists       (no terminable worker, no decoder)

  reject  WebP ANMF containing two VP8L bitstreams          (parser and decoder could pick apart)
  reject  WebP ANMF containing no bitstream                  (a frame with no picture)
  reject  WebP ANMF whose ALPH follows its VP8 chunk         (alpha must precede the bitstream)
  reject  WebP ANMF with two ALPH chunks                     (at most one)
  reject  WebP ANMF with ALPH beside a VP8L bitstream        (VP8L carries its own alpha)
  reject  WebP ANMF nested chunk with a nonzero pad byte     (nested padding must be zero)
  reject  WebP ANMF nested chunk running past the ANMF payload   (nested walk out of bounds)
  reject  WebP frame 7 whose VP8 dimensions differ from its ANMF rectangle  (every frame, not one)
  reject  WebP with the ANIM flag set and no ANIM chunk      (flag and chunk must agree)
  reject  WebP with two ANIM chunks                          (exactly one)
  reject  WebP with an ANIM chunk and no ANIM flag           (same)
  reject  WebP VP8X with a nonzero reserved bit              (reserved must be zero)
  reject  APNG fdAT of length 3                              (no frame data after the sequence number)
  reject  APNG fdAT before any fcTL                          (frame data with no frame control)
  reject  APNG fcTL followed immediately by another fcTL     (empty frame)
  reject  APNG fcTL followed only by IEND                    (empty frame)
  reject  APNG whose second frame is carried by IDAT         (IDAT is frame data for frame 0 only)
  reject  APNG fcTL with dispose_op 3                        (enum is 0-2)
  reject  APNG fcTL with blend_op 2                          (enum is 0-1)
  reject  asset larger than RASTER_SOURCE_MAX_BYTES          (refused before any worker)
  reject  re-encoded PNG larger than RASTER_OUTPUT_MAX_BYTES (checked in the worker, before transfer)
  reject  request arriving with RASTER_QUEUE_MAX_JOBS queued (refused, not queued)
  reject  image that would exceed RASTER_LIVE_MAX_PIXELS     (rendered surface budget; alt text)
  reject  queued entry whose deadline passed before dequeue  (no fetch, no worker)
  reject  queued entry whose response was disposed           (cancelled, running job terminated)
  reject  worker construction under the current CSP          (no worker-src; denied before boot)

  accept  packaged single-file worker booting from a blob URL    (worker-src blob: in place, ready
                                                                  message answered)
  accept  duplicate request for one (response id, asset id)      (deduplicated to a single job)

  cleanup input bytes transferred, not cloned                 (postMessage transfer list both ways;
                                                               parent buffer detached after send)
  cleanup PNG URL revoked when the last loading reference goes    (never before the renderer decoded
                                                                   it, and never while a removal
                                                                   continuation is still pending)
  cleanup worker-source URL revoked once the worker reports ready (a different resource from the
                                                                   PNG URL)
  cleanup live-surface budget released when the image leaves the DOM
  reject  request whose queue wait alone consumes the deadline    (timer starts at enqueue)
  reject  request whose source fetch outlives the deadline    (fetch aborted, no worker)
  reject  expired entry at dequeue                            (no fetch, no worker constructed)
  reject  worker that never reports ready                     (deadline; source URL still revoked)
  reject  parent output that would exceed RASTER_PENDING_OUTPUT_BYTES  (dropped, alt text)
  reject  image whose load and error never fire               (RASTER_SETTLE_TIMEOUT_MS; URL revoked,
                                                               charges released, alt text)
  reject  APNG whose first fcTL precedes IDAT with 32x32 in a 64x64 IHDR  (default frame must be the
                                                                          whole canvas)
  reject  APNG whose first fcTL precedes IDAT with x_offset 8  (offsets must be zero)
  reject  APNG with IDAT, then a tEXt, then another IDAT      (IDAT chunks must be consecutive)
  reject  WebP VP8X with the low reserved flag bit set        (every reserved bit is zero)
  reject  WebP VP8X with a nonzero reserved byte              (same)
  reject  WebP ANMF present with the ANIM flag unset          (container disagrees with itself)
  reject  WebP ALPH with an empty payload                     (no header byte)
  reject  WebP ALPH with a nonzero reserved bit               (header validated, not counted)
  reject  WebP ALPH with an undefined compression method      (same)
  reject  WebP ANMF with an unknown chunk before its bitstream    (reconstruction order)

  accept  WebP ANMF with an unknown chunk after its bitstream (tolerated only there)
  accept  one asset rendered three times in a response        (one decode, three consumers, three
                                                               live-pixel charges)
  accept  parent and worker clocks with different time origins    (remainingMs crosses, stamps
                                                                   never do)

  cleanup async encoder still reading the canvas              (canvas retained until the encode
                                                               settles, then reset and dropped)
  cleanup forced worker.terminate()                           (no worker finally runs; the realm's
                                                               destruction is what releases them,
                                                               and the parent drops its own side
                                                               unconditionally)
  cleanup one consumer removed while another still loads      (the shared URL is reference-counted
                                                               and never revoked out from under a
                                                               live consumer)
  reject  PNG chunk whose CRC does not match                  (verified before its contents are used)
  reject  PNG chunk type with a non-letter byte               (not a chunk type)
  reject  PNG chunk type with the reserved bit set            (a format this parser does not implement)
  reject  PNG with an unknown critical chunk                  (a decoder could not render it either)
  reject  PNG whose IEND length is not 0                      (IEND carries no data)
  reject  PNG with bytes after IEND                           (datastream must end exactly there)
  reject  WebP ALPH method 0 one byte short of width x height (truncated alpha plane)
  reject  WebP ALPH method 0 one byte longer than width x height  (data the format has no place for)
  reject  source whose declared size exceeds RASTER_SOURCE_MAX_BYTES   (refused at transfer start)
  reject  source whose accumulated chunks exceed it           (transfer failed mid-stream; no worker
                                                               is ever constructed)
  reject  output offer larger than the remaining pending capacity  (refused at output.ready; the
                                                                    buffer never enters the parent)
  reject  transferred output whose length differs from its reservation  (buffer disposed; the
                                                                          reservation stays until
                                                                          detachment is proven or
                                                                          the hold owns it)
  reject  reserved output whose transfer never arrives        (the deadline terminated the worker
                                                               before any result callback began, so
                                                               no parent buffer exists and the
                                                               job-owned reservation releases once)
  reject  result callback beginning after the deadline        (not rendered; its parent buffer is
                                                               disposed and stays charged until that
                                                               disposal succeeds)
  reject  result callback beginning after cancellation        (same)

  accept  WebP ALPH method 0 of exactly width x height bytes  (exact alpha plane)
  accept  WebP ALPH method 1                                  (compressed; dimensions implicit, no
                                                               nested header expected)
  accept  worker success                                      (PNG URL not revoked, consumer settle
                                                               timers not cleared; only job-owned
                                                               resources released)
  accept  deadline firing before the result callback begins   (termination fences the delivery; no
                                                               buffer arrives, one release)
  accept  result winning immediately before its timer fires   (the timer callback finds a terminal
                                                               job and does nothing)
  accept  cancellation racing a worker error                  (one terminal transition; every
                                                               release happens once)

  accept  loaded image keeping its live-pixel charge          (charge ends at DOM removal, not at
                                                               load; the surface is still there)
  accept  result task running after deadlineAt while its timer task is still queued
                                                              (expireIfDue takes the deadline path
                                                               from the result callback itself)
  accept  handoff reserving 2 x N, then dropping to N         (downgrade only after the ArrayBuffer
                                                               is transferred back and detached)
  accept  two render passes for one response and asset        (distinct renderPassId, distinct jobs,
                                                               no collision and no shared group)
  accept  PNG chunk with a correct PNG-algorithm CRC          (polynomial 0x04C11DB7, ones-initial,
                                                               type and data only, complemented,
                                                               big-endian)

  reject  error before load                                   (a provider error event; both
                                                               reservations released, no decoded
                                                               surface was ever made)
  reject  settle timeout before load                          (routed through removing-before-load;
                                                               nothing released in the timer stack)
  reject  output whose 2 x N handoff does not fit though N would
                                                              (the two-copy cost is the real bound)
  reject  handoff throwing part-way through URL and consumer setup
                                                              (rolled back once: URL revoked,
                                                               references dropped, timers cleared,
                                                               pixel and byte charges released)
  reject  handoff where no consumer can reserve pixels        (output released; no render group is
                                                               created at all)
  reject  Base64 chunk whose encoded length cannot fit the remaining decoded capacity
                                                              (refused before Buffer.from, so the
                                                               oversized chunk is never decoded)
  reject  Base64 chunk over the fixed per-chunk ceiling       (refused on its own terms)
  reject  PNG chunk with a one-bit mutation in its type       (CRC mismatch)
  reject  PNG chunk with a one-bit mutation in its data       (CRC mismatch)
  reject  PNG chunk with a one-bit mutation in its stored CRC (CRC mismatch)

  accept  YQ== arriving with exactly one decoded byte of capacity left
                                                              (exact length is 1, not the 3 an upper
                                                               bound would claim)
  accept  YWI= arriving with exactly two bytes of capacity left   (exact length 2)
  accept  YWJj arriving with exactly three bytes of capacity left (unpadded triplet)
  accept  a chunk of exactly 174764 encoded characters        (131072 decoded, the transport
                                                               ceiling, one padding character)
  accept  removal racing a queued load task                   (src cleared, listeners removed,
                                                               references dropped, then the pixel
                                                               charge released)
  accept  removed consumer beside one still owning a loading reference
                                                              (only the removed consumer's
                                                               reference goes, and only in its
                                                               continuation; URL and byte
                                                               reservation stay)

  reject  chunk whose exact decoded length exceeds the remaining capacity  (refused before decode)
  reject  chunk one decoded byte above 131072                 (over the transport ceiling, refused
                                                               before decode)
  reject  chunk whose encoded length is not divisible by four (not canonical, refused before decode)
  reject  chunk with padding in the middle                    (not canonical)
  reject  output.ready(0)                                     (N must be a positive safe integer)
  reject  output.ready(-1)                                    (same)
  reject  output.ready(1.5)                                   (same)
  reject  output.ready(NaN) and output.ready(Infinity)        (same)
  reject  output.ready above Number.MAX_SAFE_INTEGER          (same)
  reject  output.ready above RASTER_OUTPUT_MAX_BYTES          (refused before reservation)
  reject  output.ready whose 2 x N would exceed the safe integer range   (overflow check precedes
                                                                          arithmetic)
  reject  renderPassId reused while a job from the old pass still lives  (ids are not recycled)
  reject  renderPassId supplied or echoed by a provider       (controller mints them)

  cleanup transferred-length mismatch                         (buffer disposed and detachment
                                                               confirmed before any release)
  cleanup buffer arriving after the deadline                  (ignored by the settle-once state and
                                                               still disposed)
  cleanup cancellation after the grant but before the result  (reservation pinned until the buffer
                                                               arrives and its disposal succeeds)
  cleanup worker dying after the parent received the buffer   (a dedicated disposal worker takes the
                                                               buffer and is terminated; if none can
                                                               be constructed, the hold takes it)
  cleanup disposal that throws or leaves byteLength nonzero   (buffer and full 2 x N move to the
                                                               disposal hold, which owns them until
                                                               a later disposal succeeds)
  cleanup completed job cleanup                               (releases job-owned resources only;
                                                               the render group's reservation is
                                                               untouched)
  cleanup render pass registry entry                          (removed only after every job and
                                                               render group for that pass is gone)

  accept  removal that does not release pixels in the mutation stack
                                                              (nothing is released until the image
                                                               update has run)
  accept  image-update microtask running before the release continuation
                                                              (requests aborted and image data
                                                               forgotten first)
  accept  load task already queued when removal begins        (settle-once refuses the second
                                                               outcome)
  accept  error task already queued when removal begins       (same)
  accept  document holding a reference until the image update completes
                                                              (release waits for it, not for the
                                                               allocator)
  accept  teardown racing removing-before-load                (idempotent; one path completes)
  accept  renderPassId 3f2a1b40-0000-4000-8000-0000000c0ffe   (36 characters, lowercase v4)

  reject  renderPassId of 35 or 37 characters                 (exact length)
  reject  renderPassId in uppercase or braces                 (lowercase canonical only)
  reject  renderPassId that is not RFC 4122 version 4         (malformed)
  reject  renderPassId reused while a job or group from the old pass still exists

  cleanup timeout wins before the result callback begins      (terminate() empties the port queue;
                                                               the queued result cannot arrive, and
                                                               the reservation releases once)
  cleanup cancellation wins before the result callback begins (same fence, same single release)
  cleanup result callback begins first, after deadlineAt      (buffer is observed, never rendered,
                                                               and routed through disposal)
  cleanup result callback begins before cancellation          (a known buffer follows the ordinary
                                                               disposal path)
  cleanup successful disposal                                 (transfer returns, byteLength is 0,
                                                               terminate() invoked, logical charge
                                                               released once)
  cleanup disposal worker unavailable                         (buffer and the full 2 x N move to the
                                                               disposal hold)
  cleanup hold retried on the next named drain trigger        (succeeds once, releases once, entry
                                                               removed)
  cleanup webview destruction with holds outstanding          (the realm goes; no worker needed)

  accept  disposal transfer that returns, reports byteLength 0, and is terminated
                                                              (logical release proceeds; no
                                                               allocator claim is made)
  accept  entering removing-before-load                       (the loading reference is not
                                                               decremented yet)
  accept  the removal continuation after the image-update microtask
                                                              (listeners removed, references
                                                               dropped, loading reference
                                                               decremented, pixel charge last)
  accept  renderer image with no picture ancestor and no srcset
                                                              (removing src selects a null source)
  accept  randomUUID colliding with a live pass id            (re-minted, never reused)

  reject  renderPassId supplied by a provider                 (controller mints them in the webview)

  cleanup disposal worker constructor failure                 (attached buffer and full 2 x N move
                                                               to the hold)
  cleanup disposal postMessage throwing                       (same)
  cleanup disposal leaving byteLength nonzero                 (same; nothing is released)
  cleanup teardown racing removing-before-load                (the group is marked tearing-down and
                                                               the record stays registry-owned; its
                                                               continuation completes and releases
                                                               each resource once)
  cleanup shared URL while another loading reference exists   (not revoked, bytes not released)

  accept  disposal worker source URL retained until dispose.ready
                                                              (ports entangle only after the script
                                                               loads; revoking earlier proves
                                                               nothing)
  accept  dispose.ready, then revoke, transfer, verify byteLength 0, terminate
                                                              (the whole ordering, in order)
  accept  pre-load removal disconnecting the img before its continuation
                                                              (alt text replaces it in the same
                                                               stack; no sourceless img is left in
                                                               the document)
  accept  settle timeout entering removing-before-load        (same deferred continuation as any
                                                               other removal)
  accept  cleanup record carrying consumerToken and renderGroupId
                                                              (the continuation can reach the group
                                                               it must decrement)
  accept  teardown leaving the group tearing-down until the last record completes

  reject  disposal worker failing before dispose.ready        (constructor throw, worker error, CSP
                                                               refusal or readiness timeout: worker
                                                               terminated, URL revoked, attached
                                                               buffer and full 2 x N to the hold)

  cleanup repeated teardown and repeated continuation         (terminal-once on the record; no
                                                               double release)
  cleanup last record completing                              (loading count reaches zero: URL
                                                               revoked, Blob dropped, pending bytes
                                                               released, group deleted)

  accept  dispose.ready arriving before disposalDeadlineAt    (transfer path proceeds; the timer
                                                               becomes inert)
  accept  dispose.ready callback starting after disposalDeadlineAt while the timer task is queued
                                                              (expireDisposalIfDue expires the
                                                               attempt from the ready callback
                                                               itself)
  accept  two hold records                                    (drained FIFO, one disposal worker at
                                                               a time, never two)
  accept  one disposal worker beside the single validation worker
                                                              (permitted; two disposal workers are
                                                               not)
  accept  settle timeout on a connected element               (parent and nextSibling captured, then
                                                               replaced with a text fallback)
  accept  controller-initiated removal on a connected element (same capture-then-replace; a fallback
                                                               is required)
  accept  alt text reading <script>alert(1)</script>          (rendered as those characters, via a
                                                               text node)
  accept  alt text reading <img onerror=alert(1)>             (same)

  reject  dispose.ready with a different or missing attemptToken   (ignored; transfers nothing)
  reject  a second dispose.ready for one attempt              (ignored; the attempt is terminal-once)
  reject  a wrong-shaped ready message                        (ignored)
  reject  alt text inserted through innerHTML or reparsed as Markdown
                                                              (text nodes only, by contract)

  cleanup ready, error and timer racing                       (one terminal transition; timer
                                                               cleared, listeners removed, source URL
                                                               revoked, worker terminated, once)
  cleanup removal of an element observed already disconnected (no fallback inserted; src cleared on
                                                               the retained element and the deferred
                                                               cleanup runs)
  cleanup response teardown                                   (no fallback written into a response
                                                               being destroyed; records run to group
                                                               finalisation)
  cleanup continuation whose renderGroupId resolves to nothing    (invariant breach: the turn fails
                                                                   and the renderer realm is
                                                                   destroyed through the final
                                                                   cleanup boundary; charges are not
                                                                   left orphaned)

  accept  ready callback passing the clock, then the pre-transfer check reaching the deadline
                                                              (ready -> expired; no transfer, and
                                                               the attached buffer goes to the hold)
  accept  postMessage throwing after ready                    (ready -> failed; attached buffer to
                                                               the hold)
  accept  timer, error or ready callback after terminal settlement    (inert; no second release and
                                                                       no second transfer)
  accept  successful head disposal with another record queued (schedules exactly the next record)
  accept  one named trigger after a stopped failure           (exactly one new attempt)
  accept  output.ready after the hold drains                  (ordinary admission and reservation)
  accept  output.ready with no hold at all                    (reservation rules unchanged)

  reject  output.ready while a hold record remains            (refused before any transfer grant;
                                                               that image renders as alt text)
  reject  output.ready while a disposal attempt is active     (same)
  reject  output.ready while several FIFO holds remain        (refused until all of them drain)
  reject  output.ready after a disposal failure left the hold populated   (refused; occupancy, not
                                                                           arithmetic)

  cleanup failed attempt with drainPending false              (record stays at the FIFO head, the
                                                               attempt clears, nothing reschedules,
                                                               and the charge stays pinned)
  cleanup failed attempt with drainPending true               (the flag is consumed, a token is
                                                               minted, and exactly one later task
                                                               calls requestHoldDrain)
  cleanup trigger arriving while a retry task is queued       (it sees scheduledDrainToken, sets
                                                               drainPending and starts nothing; the
                                                               task collapses both into one attempt)
  cleanup head A succeeding with drainPending set, then head B failing
                                                              (success re-enters requestHoldDrain,
                                                               which consumes the flag before B
                                                               starts, so B's failure stops instead
                                                               of spending a trigger nobody sent)
  cleanup destruction after a retry task is queued            (token invalidated, callback inert, no
                                                               worker constructed)
  cleanup superseded scheduled callback running               (token mismatch: returns without
                                                               changing state or starting anything)
  cleanup second failure with no new trigger                  (stops again; no spin)
  cleanup successful disposal of the last record while drainPending is set
                                                              (queue empties; both the flag and the
                                                               scheduled token are cleared, and no
                                                               empty-queue attempt starts)
  cleanup realm destruction with holds and an active attempt  (registryDestroyed set, token
                                                               invalidated, drainPending cleared,
                                                               callbacks inert, active worker
                                                               terminated, nothing constructed)
  cleanup ten triggers arriving during one active attempt     (coalesced into a single drainPending,
                                                               so exactly one later attempt)

  cleanup three consumers of one asset                        (the first two dropping their loading
                                                               references keep the shared Blob, URL
                                                               and byte reservation; the third's
                                                               release takes the count to zero and
                                                               frees them once, while each pixel
                                                               charge waits for its own removal)
  cleanup one consumer timing out beside a loading consumer   (the timed-out consumer runs the
                                                               removal continuation and frees only
                                                               its own charges; the shared URL and
                                                               pending bytes stay for the other)
  cleanup response teardown with consumers outstanding        (the group is marked tearing-down and
                                                               kept reachable; every registry-owned
                                                               record completes, and the shared URL
                                                               and byte reservation go when the last
                                                               loading reference does)
  cleanup 128 images requested at once                        (concurrency stays one; every worker
                                                               that was constructed is terminated,
                                                               and expired queued entries are
                                                               discarded without constructing one at
                                                               all; both URLs revoked at their own
                                                               moments, every arrived buffer disposed
                                                               before its charge is released, and
                                                               pending-byte and live-pixel charges
                                                               released once)
  ```
- Every other image destination is rejected, `http` and `https` included. The block becomes its
  alt text, so the answer keeps its meaning without the fetch.
- `mailto:` as an image source is meaningless and rejected with the rest.

**Destination canonicalization**, the exact algorithm, run identically by producer, both parsers
and the renderer. Applied to every destination form CommonMark accepts: inline `[a](dest)`,
angle-bracket `[a](<dest>)`, reference definitions `[id]: dest`, autolinks `<dest>`, image sources,
and the destination half of a shortcut or collapsed reference. Titles are not destinations and are
carried as text.

1. Trim leading and trailing `U+0020` — and only `U+0020` — that CommonMark itself allows around a
   destination. This is syntax, not content, and it happens before anything is judged.
2. Reject if what remains contains any character in `U+0000`–`U+001F`, `U+0020`, or
   `U+007F`–`U+009F`. Interior whitespace and control characters are an obfuscation attempt, not a
   valid URL; a rejection, not a strip, so `java\tscript:` never reaches step 3.
3. Decode HTML character references once — named and numeric — since Markdown carries them
   literally. A reference that does not resolve is left as its literal characters.
4. Percent-decode with the scanner below, at most **3** passes. The scanner exists because a
   destination is text, not bytes: it can hold literal Unicode and percent escapes side by side,
   and treating the whole string's code units as bytes is undefined the moment a character above
   `U+00FF` appears.

   ```text
   decodeOnce(input):
       output := ""
       i := 0
       while i < length(input):
           if input[i] is not "%":
               output += input[i]        # any Unicode character, copied unchanged
               i += 1
               continue
           # maximal run: every consecutive "%XY" starting here, and nothing else
           run := []
           while i < length(input) and input[i] is "%":
               if i + 2 >= length(input): reject          # truncated escape
               if input[i+1..i+2] are not both hex digits: reject
               run += byte 0xXY from input[i+1..i+2]
               i += 3
           if run is not strictly valid UTF-8: reject     # judged per run, not per string
           output += strict UTF-8 decode of run
       return output

   for pass in 1..3:
       if the string contains no "%": stop
       decoded := decodeOnce(string)
       if decoded equals string: stop
       string := decoded
   if decodeOnce(string) would still change it: reject
   ```

   Three passes are performed, not two; the rejection is for a destination that is still changing
   after all three. A malformed escape is a rejection at the run that meets it, never a silent
   pass-through.

   **Byte semantics, so two implementations cannot disagree.** Each *maximal consecutive run* of
   `%XY` escapes becomes a byte string, and that byte string alone is decoded as UTF-8 in strict
   mode — the equivalent of `new TextDecoder("utf-8", { fatal: true })`, never a lossy decode that
   substitutes `U+FFFD`. Strict means: no overlong forms, no surrogate code points
   `U+D800`–`U+DFFF`, nothing above `U+10FFFF`, no truncated sequence. Any of those is a rejection,
   not a replacement character, because a replacement character is a decision about bytes nobody
   agreed on.

   Two consequences worth stating, because they are where implementations would otherwise drift:

   - Literal Unicode outside the escapes is copied through untouched and never contributes bytes.
     `https://example.com/é%C3%A9` is one literal `é` followed by an escaped one.
   - A run is judged as a unit. `%C3x%A9` is two runs — `%C3` and `%A9` — and each is invalid on
     its own, so it is rejected. Concatenating them across the intervening `x` to form a valid
     sequence is exactly the leniency this scanner refuses.

   Fixtures, shared by producer, both parsers and the renderer:

   ```text
   accept  https://example.com/%C3%A9        (valid two-byte UTF-8, decodes to é)
   accept  https://example.com/%E2%9C%93     (valid three-byte UTF-8)
   accept  https://example.com/é%C3%A9       (literal Unicode beside an escaped run)
   accept  https://example.com/%C3%A9é%E2%9C%93  (runs separated by literal Unicode)
   reject  https://example.com/%C3x%A9       (one valid sequence split across two runs)
   reject  https://example.com/%C0%AE        (overlong encoding of ".")
   reject  https://example.com/%FF           (not valid UTF-8)
   reject  https://example.com/%ED%A0%80     (surrogate code point)
   reject  https://example.com/%C3           (truncated sequence)
   reject  https://example.com/%GG           (malformed percent escape)
   reject  javascript%3Aalert(1)           (encoded control of the scheme boundary)
   reject  https://example.com/%09path     (encoded tab, a control character)
   ```
5. Repeat step 2 against the decoded result. Any control character or space that appears through
   decoding is a rejection.
6. Take the scheme as the characters before the first `:`, lowercased with ASCII case folding only.
   No `:` at all, or a leading `/`, `?`, `#` or `.`, means a relative destination — rejected.
7. Compare the scheme against the allowlist for that position: link or image.

The producer runs this before emitting; the parsers run it on receipt; the renderer runs it again
before any destination reaches the DOM. Three implementations of one algorithm is deliberate — each
one is a place the others' mistakes stop.

**Renderer, in the controller.** The Markdown renderer runs with raw HTML disabled at the library
level — not sanitized afterwards, disabled — and with the canonicalization and allowlists above
applied to whatever destinations survive. Rendering is the last line, not the only one: a parser
that rejects and a renderer that cannot be persuaded to emit markup have to both hold.

**Activity text is not Markdown.** `reasoning_summary` and `commentary` deltas are plain text and
are rendered as plain text — inserted as text, never as markup, never parsed as Markdown. So the
literals below are *accepted* in activity and displayed exactly as written: a model that says
`<script>alert(1)</script>` in a status line has said those characters, and showing them is
correct. Rejecting them would be both wrong and useless, since the danger is in rendering, not in
the bytes. What the contract forbids is any consumer treating activity text as markup.

**Fixtures.** Each literal below is a rejection case in a `markdown` field, and the same literals
are acceptance cases in activity text, where the expected result is the characters themselves,
escaped for display:

```text
<script>alert(1)</script>
<img src=x onerror=alert(1)>
<div onclick="alert(1)">text</div>
[label](javascript:alert(1))
[label](JaVaScript:alert(1))
[label](java&#9;script:alert(1))
[label](%6Aavascript:alert(1))
![image](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)
[label](vbscript:msgbox(1))
[label](//evil.example/path)
[label](../relative)
```

Accepted alongside them, so the rules do not quietly ban ordinary content:

```text
[label](https://example.com/a?b=c#d)
[label](mailto:someone@example.com)
`<script>alert(1)</script>`  (inside a code span, carried as text)
![alt](bachata-asset:asset-9f2c1e40-0000-4000-8000-000000000000)  (registered this turn, image/png)
```

Image-specific rejections, which the link corpus does not cover:

```text
![alt](https://example.com/tracker.png)
![alt](http://example.com/pixel.gif)
![alt](mailto:someone@example.com)
![alt](bachata-asset:../escape)
![alt](bachata-asset:asset-not-a-uuid)
![alt](bachata-asset:asset-9f2c1e40-0000-4000-8000-000000000000/extra)
![alt](bachata-asset:asset-9f2c1e40-0000-4000-8000-000000000000)  (well formed, not in this turn)
![alt](bachata-asset:asset-9f2c1e40-0000-4000-8000-000000000000)  (registered, image/svg+xml)
```

## Typed visible activity

Kinds:

```text
reasoning_summary | commentary | final_answer
```

Rules:

- Public visible text only. Never hidden chain-of-thought, never a provider's internal reasoning
  channel. If a provider stops rendering a summary, the bridge emits nothing for it.
- A provider whose boundary is unproven emits `final_answer` only. Claude and generic providers
  start there, and stay there until their own live evidence exists.
- `final_answer` is the response. `reasoning_summary` and `commentary` are history and never
  substitute for it.

Wire shape. One `conversation.activity` message is one event, not one item:

```json
{
  "type": "conversation.activity",
  "protocolVersion": 10,
  "requestId": "req-1",
  "agentId": "agent-1",
  "sessionId": "session-1",
  "sequence": 3,
  "itemKey": "commentary:2",
  "kind": "commentary",
  "delta": " and checked the second file",
  "committed": false
}
```

Fields:

- `sequence`: monotonic and gapless **per response**, one step per event. Two events for the same
  item carry different sequences; the item is identified by `itemKey`, never by `sequence`. This is
  what the earlier draft got wrong by implying repeated growth reuses a sequence.
- `itemKey`: stable identity of one visible item for the life of the response.
- `kind`: fixed for an item once its first event is sent.
- `delta`: text appended to that item. The item's full text is the ordered concatenation of its
  deltas. There is no replacement form.
- `committed`: when true, this event closes the item. A later event for a committed `itemKey` is a
  protocol error.

Growth of one item across three events:

```json
{ "sequence": 1, "itemKey": "reasoning:1", "kind": "reasoning_summary", "delta": "Reading the diff", "committed": false }
{ "sequence": 2, "itemKey": "reasoning:1", "kind": "reasoning_summary", "delta": " and the tests", "committed": false }
{ "sequence": 3, "itemKey": "reasoning:1", "kind": "reasoning_summary", "delta": "", "committed": true }
```

Commentary split by a tool row, then the answer:

```json
{ "sequence": 4, "itemKey": "commentary:1", "kind": "commentary", "delta": "Looking at the parser.", "committed": true }
{ "sequence": 5, "itemKey": "commentary:2", "kind": "commentary", "delta": "The parser rejects it.", "committed": true }
{ "sequence": 6, "itemKey": "final", "kind": "final_answer", "delta": "The cause is the strict key check.", "committed": true }
```

Temporal invariants belong to a stateful ledger in the controller, not to the parser:

- A sequence gap or a repeated sequence is a protocol error.
- A second event for a committed `itemKey` is a protocol error.
- Changing an item's `kind` after its first event is a protocol error.
- An item disappearing from the DOM is not a retraction and never duplicates.

The stateless parser validates shape, kinds, coverage, size and protocol version only.

## Uncommitted text, rewrites, and the final answer

Deltas cannot be retracted, so the producer must not emit one it may need to take back.

- An uncommitted item grows by prefix extension only. The producer emits a delta for the part that
  is settled and holds the rest.
- If an uncommitted item's visible text changes in a way that is not prefix extension — the
  renderer rewrote what was already sent — the producer fails the turn. It never re-sends the item
  under a new `itemKey`, because the controller has already shown the old text and cannot unsay it.
- If the rewrite affects only text the producer has not yet emitted, nothing is wrong: the item
  simply continues from the new settled prefix.
- A rewrite of a committed item is a protocol error, as above.

`final_answer` activity and the authoritative response are the same text, not two sources:

- The response `text` in `conversation.response` is authoritative. Activity is the running view of
  it.
- The producer must ensure the ordered concatenation of committed `final_answer` deltas equals the
  response `text`. A mismatch fails the turn; the response is never quietly adjusted to match the
  activity, and the activity is never replayed to match the response.
- A turn may end with no `final_answer` activity at all — a producer that streams nothing still
  returns a response. The reverse, activity without a response, is a failed turn.

## Virtualization and reparent recovery

- The producer commits a block only after a following block exists, so a still-growing tail is
  never frozen.
- A virtualized prefix that vanishes from the DOM is a missing observation, not a retraction. The
  ledger keeps what was committed.
- A reparented or replaced response root resets stability, not identity: committed items stay
  committed and the producer resumes from the last committed sequence.
- Before success the producer performs one authoritative uncached reread. That snapshot is the
  final answer. If it contradicts a committed item, the turn fails; it is never silently rewritten.

## Limits

All byte counts are UTF-8, measured with `TextEncoder`. `JSON.stringify(...).length` is UTF-16 code
units and is not byte accounting; the comparison source gets this wrong at
`miuuyy/codex-chatgpt-web@09877fa:src/responses/state.ts:31` and `:119`. Do not copy it.

| Limit | Value |
| --- | --- |
| Response `text` | 50 MiB, unchanged from v9 |
| Whole message | 80 MiB, unchanged from v9 |
| Blocks per response | 4096 |
| `markdown` per block | 1 MiB |
| Activity items per response | 512 |
| Activity events per response | 4096 |
| `text` per activity item | 256 KiB |
| Nesting depth reported per block | 8 |

Over-limit is a rejection, never a truncation.

## Compatibility

- New endpoint path: `/bachata-browser-bridge-v10`.
- `protocolVersion: 10` on every message. Exact-version pairing is retained: a v9 client and a v10
  client never share a session, and no message mixes versions.
- A stored v9 endpoint is migrated on upgrade by rewriting the path; the saved token is retained.
  If the migrated endpoint refuses the handshake, the bridge reports unpaired rather than falling
  back to v9.
- `protocol/browser-protocol-v10.contract.json` is authored once and copied byte-identically to the
  controller. `protocol/browser-bridge.compatibility.json` records the new SHA-256.
- The v9 contract is removed only after migration tests pass.

## Fixture corpus

The same corpus must produce the same verdict in both repositories.

Accept:

1. Plain answer, one paragraph.
1a. Non-ASCII answer with astral characters, proving offsets are UTF-16 code units and that size
   limits are UTF-8 bytes measured with `TextEncoder`.
2. GFM: heading, list, fenced code with language, table, link, bold.
3. Reasoning summary, then commentary, then final answer.
4. Commentary split by tool rows into two items with distinct sequences.
4a. A nested ordered list, as `listItem` blocks with `depth`, `ordinal` and `listKey`.
5. Virtualized prefix: committed blocks absent from the final snapshot.
6. Ordered list continuing across a reparent.

Reject:

1. Unknown block kind.
2. Unknown activity kind.
3. Blocks that do not tile `text`.
4. `language` on a non-`code` block.
5. Over-limit `markdown`, over-limit item text, over-limit block count.
6. Mixed `protocolVersion` inside one session.
7. Sequence gap, repeated sequence, event after commit, kind change after first event (ledger, not
   parser).
8. Block ranges that leave a gap, overlap, or do not start at 0 / end at `text.length`.
9. A range whose remainder after `block.text` is not a separator run.
10. A `list` or `html` block kind, `listKind` or `ordinal` on a non-`listItem` block.
10a. A `markdown` field containing an HTML tag token outside a code span, a link destination
   outside the link allowlist, or an image source that is not a `bachata-asset:` reference — every
   literal in the injection-boundary fixture lists, each as its own case.
10b. A destination carrying a control character or interior space, containing a malformed percent
   sequence, still changing after three percent-decode passes, or resolving to a relative path.
10d. An image source that is not `bachata-asset:asset-<UUID>`, names an asset outside the current
   turn's registry, names one whose content type is outside the raster allowlist, or names one
   whose bytes do not sniff as the raster format they claim. Also: coded or decoded dimensions over
   the raster limits; a decoded pair — `VideoFrame.displayWidth`/`displayHeight` — that is neither
   the coded pair nor its exact transpose; a source whose encoded chunk, declared size or accumulated
   size exceeds `RASTER_SOURCE_MAX_BYTES` at the fetch boundary, a non-canonical Base64 chunk or one
   whose exact decoded length exceeds the remaining capacity or the 131072-byte transport ceiling, a
   re-encoded PNG over `RASTER_OUTPUT_MAX_BYTES`, an `output.ready(N)` that is not a positive safe
   integer within `RASTER_OUTPUT_MAX_BYTES` with a representable `2 × N`, an output whose `2 × N`
   handoff cannot be reserved against `RASTER_PENDING_OUTPUT_BYTES`, or a transferred length
   disagreeing with its reservation; a request beyond `RASTER_QUEUE_MAX_JOBS` or a rendered surface beyond `RASTER_LIVE_MAX_PIXELS`; an
   image that never settles inside `RASTER_SETTLE_TIMEOUT_MS`; a queued entry that expired or whose
   response was disposed; a
   header the bounded parser cannot state dimensions from;
   a JPEG that is hierarchical (`DHP` or `EXP` before SOF, or a differential SOF) or whose SOF has a
   zero dimension, a DNL-deferred height, `Nf` outside 1–255, or `Lf` other than `8 + 3 × Nf`; an
   `FF00`, `RST`, second `SOI`, `EOI` or `SOS` before SOF; a duplicate `IHDR` or `VP8X`; a container
   whose structural walk does not reach its end point inside the classification bound; an `acTL`
   after the first `IDAT`; non-consecutive `IDAT` chunks, or a default-image frame that is not the
   full canvas at zero offsets; a malformed `acTL`, `fcTL`, `ANIM` or `ANMF` length, an `fdAT` under 4
   bytes or without an active `fcTL`, an empty APNG frame, a `dispose_op` outside 0–2 or `blend_op`
   outside 0–1, an `ANIM` chunk disagreeing with the `ANIM` flag, an `ANMF` without that flag, a
   nonzero reserved bit anywhere in `VP8X` or `ANMF`, an `ANMF` without exactly one bitstream, an
   `ALPH` duplicated, misplaced, beside `VP8L`, empty, or carrying reserved bits or an undefined
   compression method, an unknown nested chunk before the bitstream, a nested chunk out of bounds or
   with nonzero padding, a broken APNG sequence, or a frame count disagreeing with
   the structure; an animation-marked container with fewer than two frames; any frame rectangle that
   is empty or outside its canvas; a nested bitstream disagreeing with its `ANMF` rectangle in any
   frame; a RIFF size mismatch, a missing odd-chunk pad
   byte or one that is not zero; an absent `VP8`/`VP8L` signature; a selected decoder track whose
   `animated` or `frameCount` disagrees with the structural walk; an animated container with no
   `ImageDecoder`; a PNG chunk failing its CRC, carrying a non-letter type byte or a set reserved
   bit, an unknown critical chunk, a non-empty `IEND` or bytes after it; an `ALPH` whose method-0
   payload is not exactly `frame_width × frame_height`; a worker that cannot be constructed under the
   webview's policy; a `renderPassId` that a provider supplied or that is reused while a job from the
   old pass still lives, or one that is not exactly 36 lowercase RFC 4122 version 4 characters; an image with a `<picture>` ancestor, a `srcset`, or any source other than the
   shared PNG URL; a disposal whose transfer fails or leaves the buffer attached, which moves it and
   the full `2 × N` to the disposal hold; a result arriving after the deadline or after cancellation, which is routed
   through disposal rather than rendered; a handoff in which no consumer can reserve pixels, or which fails part-way
   and rolls back; and anything — queue wait, source fetch, worker startup, the output handshake,
   either transfer, walk, decode, re-encode or committed handoff — that exceeds the parent's
   2-second deadline, which starts at enqueue and ends at that commit. An image's own `load` is not
   inside it; that is `RASTER_SETTLE_TIMEOUT_MS`.
10c. Activity text is never rejected for its contents: the same literals are acceptance cases there,
   displayed as characters.
11. Committed `final_answer` deltas that do not concatenate to the response `text`.
12. A non-prefix rewrite of an uncommitted item.

## Dependencies

No new dependency. `turndown@7.2.0` and `turndown-plugin-gfm@1.0.2` are already declared and are
already used by the generic capture path.

Build change instead: the built-in content scripts are plain `tsc` output injected as a file list,
so they cannot import a package. Markdown conversion must be published as one esbuild-bundled
`content/markdown.js` exposing a global, in the same handoff style as `__pairProviderLogic`, and
added to the injection list, the packaged-entry allowlist, and the coverage gates.

## Privacy

This is an expansion, stated plainly rather than waved off.

- Markdown itself sends nothing new: it re-encodes text v9 already captured.
- Typed activity **does** send more. Reasoning summaries and intermediate commentary are content
  the controller never received under v9. They are on-screen text a person reading the tab can
  already see, and never a hidden reasoning channel — but "visible in the page" is not the same as
  "already leaving the page", and this decision moves that line.
- Consequences to accept or refuse: activity text lands in controller memory, in whatever the
  controller logs or renders, and in any transcript a task keeps. It is captured on turns a person
  is not watching. A provider that renders account or file names inside a status row exports those
  too.
- Mitigations in the contract: per-item and per-response caps, no persistence in the bridge, no new
  storage, no telemetry, activity kinds emitted only for providers with proven boundaries, and the
  injection boundary above — no raw-markup block kind, no HTML tokens in `markdown`, an allowlist
  of URL schemes, raw HTML disabled in the renderer, and activity text rendered as plain text.
- Not mitigated: the controller side. If activity must be excluded from transcripts or logs, that
  is a controller policy decision and belongs in the same approval.

## Release

Atomic across both repositories: contract, parser, producers, fixtures, package allowlists,
coverage gates, notices, docs. A bridge ZIP and a controller VSIX built from different protocol
versions must not pair, and exact-version pairing already enforces that.

## Locked specification state

Buffer accounting has exactly two post-job owners: the **render group** after a committed handoff,
and the **disposal hold** when a buffer could not be transferred away. An active job still owns a
reservation it has not handed over, but a finished job owns nothing. A grant
with no delivered result needs no third owner: terminating the worker empties its port queue, so the
job's own terminal transition releases the reservation once. A reservation is released only when no
buffer arrived and the worker was terminated, or when a disposal succeeded.

Not decisions, and not blockers — recorded here so they are not reopened. One validated Blob and one
reference-counted shared PNG URL per `(responseId, assetId, renderPassId)`; one pending-byte
reservation held until no consumer owns a loading reference; a consumer set frozen before enqueue,
with a later render pass forming its own job rather than joining an old group; per-occurrence `<img>`
elements, each with its own live-pixel charge held until DOM removal; and one settle-once job state
machine whose precedence is decided by the clock rather than by task ordering.

## Open owner decisions

1. Accept the v10 compatibility surface: new endpoint path, stored-endpoint migration, no fallback.
2. Accept the privacy surface of typed activity.
3. Accept the added build step for bundled Markdown conversion.
3a. Accept the injection boundary: no `html` block kind, no HTML tokens in `markdown`, an
   `http`/`https`/`mailto` allowlist for links, and `bachata-asset:asset-<UUID>` references —
   registered in the current turn, raster content types only, no SVG, established by sniffing and
   decoding rather than by trusting declared metadata, bounded at 8192 px per side and 2^25 total
   pixels on the coded pair and on the decoded `displayWidth`/`displayHeight` pair, structural
   animation classification that must reach its format's end point or reject, per-frame geometry
   validated against the canvas, animation-marked containers with fewer than two frames refused,
   hierarchical JPEG refused, animated containers decoded on an animated track whose frame count
   matches the walk, the whole pipeline in one terminable worker behind a controller-wide queue at
   concurrency one under a parent-owned 2-second deadline, and the displayed raster — rotation and
   flip applied — re-encoded to PNG so the untrusted container never reaches the DOM — as the only
   accepted image source. Plus the
   shared canonicalization algorithm, raw HTML disabled in the controller's renderer, and activity
   text rendered as plain text.

   The costs are real and worth naming: remote images in answers stop rendering, an image a
   provider hosts is only shown if it comes through the bridge asset channel, animations render as
   their first frame or not at all, and every accepted image is re-encoded rather than passed
   through.
3b. Accept the raster pipeline's cost, including its hold-priority reading: while any disposal hold
   or active attempt exists, an `output.ready` offer is **refused** rather than parked, so every
   later image renders as alt text until the hold drains — and a hold that failed with no further
   controller activity stays pinned. One dedicated worker per deduplicated validation job, plus a
   short-lived **disposal worker** on any path where the job's own worker can no longer take its
   buffer back — disposal means destroying a realm that holds the bytes, and that needs a realm to
   destroy. A controller-wide
   queue at concurrency one, and queue waiting time charged against each job's own deadline. The
   consequence is not a slower gallery — later images in a picture-heavy response are rejected and
   shown as alt text. Concurrency one bounds concurrent jobs, not memory; what accumulates is the
   decoded surfaces the DOM keeps after those jobs are gone.
3c. Accept refusing animation-marked containers with fewer than two frames — a one-frame APNG or a
   single-`ANMF` WebP renders as alt text — since `ImageTrack.animated` means "more than one frame"
   and no track can be both animated and single-frame.
3d. Set the seven resource budgets, which nothing in the system determines and which this document
   declines to choose: `RASTER_SOURCE_MAX_BYTES`, `RASTER_OUTPUT_MAX_BYTES`,
   `RASTER_PENDING_OUTPUT_BYTES`, `RASTER_QUEUE_MAX_JOBS`, `RASTER_LIVE_MAX_PIXELS`,
   `RASTER_SETTLE_TIMEOUT_MS`, and `RASTER_DISPOSAL_START_TIMEOUT_MS` — the last one added because
   the disposal worker's readiness wait needs a bound and no existing one fits: the job deadline has
   usually already expired on the paths that need disposal, and the settle timeout measures an image
   load, not a worker start. Existing limits constrain the range without setting it — 100 assets
   per response, 128 remembered sources per document, a 64 MiB inline asset cache, an 80 MiB message
   ceiling, 2^25 pixels per validated image. Four of the seven exist because work outlives the job
   that made it, and each answers a different way it does:

   - `RASTER_PENDING_OUTPUT_BYTES` — controller-held output bytes survive the validation job, and a
     per-image output cap bounds one picture, not a gallery.
   - `RASTER_LIVE_MAX_PIXELS` — rendered surfaces stay while their elements do.
   - `RASTER_SETTLE_TIMEOUT_MS` — a consumer whose `load` and `error` never fire would hold the
     group's resources indefinitely.
   - `RASTER_DISPOSAL_START_TIMEOUT_MS` — disposal startup happens after, or outside, the job's own
     deadline, so it needs a bound of its own.
3e. Approve the webview CSP expansion the pipeline needs: `worker-src blob:` and
   `connect-src ${webview.cspSource}`. Today's policy has no `worker-src`, so worker creation falls
   back to a nonce-only `script-src` and a blob worker is denied outright. Neither addition loosens
   `script-src`, but both widen the webview's trust boundary, and the pipeline has nowhere to run
   until this is decided.
4. Select the exact contract for the chosen release track. Fidelity may ship independently;
   activity requires L1 and its privacy decision. The combined schema below is not an approved
   fidelity-only contract. Record included fields, omitted activity surface and migration tests.
