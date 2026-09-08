import { readFile, writeFile } from "node:fs/promises";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let index = 0; index < 8; index += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const value of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
};

const uint16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const uint32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value >>> 0); return buffer; };

export const createStoreZip = async (output, files) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
    const data = await readFile(file.path);
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      uint32(0x04034b50), uint16(20), uint16(0x800), uint16(0),
      uint16(0), uint16(33), uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0), name,
    ]);
    local.push(localHeader, data);
    central.push(Buffer.concat([
      uint32(0x02014b50), uint16(0x0314), uint16(20), uint16(0x800), uint16(0),
      uint16(0), uint16(33), uint32(crc), uint32(data.length), uint32(data.length),
      uint16(name.length), uint16(0), uint16(0), uint16(0), uint16(0),
      uint32(0o100644 << 16), uint32(offset), name,
    ]));
    offset += localHeader.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(centralBuffer.length), uint32(offset), uint16(0),
  ]);
  await writeFile(output, Buffer.concat([...local, centralBuffer, end]));
};

const localHeaderSize = 30;
const centralHeaderSize = 46;
const endRecordSize = 22;
const maxComment = 0xffff;

const readName = (data, start, length) => {
  const name = data.subarray(start, start + length).toString("utf8");
  if (name.length === 0) throw new Error("ZIP entry has an empty name");
  if (Buffer.byteLength(name, "utf8") !== length) throw new Error(`ZIP entry name is not valid UTF-8: ${name}`);
  if (name.includes("\\")) throw new Error(`ZIP entry name uses a backslash: ${name}`);
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new Error(`Unsafe ZIP entry: ${name}`);
  if (name.endsWith("/")) throw new Error(`ZIP directory entries are not permitted: ${name}`);
  if (name.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ZIP entry: ${name}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`ZIP entry name contains control characters: ${name}`);
  return name;
};

const findEndRecord = (data) => {
  const earliest = Math.max(0, data.length - endRecordSize - maxComment);
  for (let offset = data.length - endRecordSize; offset >= earliest; offset -= 1) {
    if (data.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = data.readUInt16LE(offset + 20);
    if (offset + endRecordSize + commentLength === data.length) return offset;
  }
  throw new Error("ZIP end record not found");
};

export const inspectStoreZip = async (file) => {
  const data = await readFile(file);
  if (data.length < endRecordSize) throw new Error("ZIP file is truncated");
  const endOffset = findEndRecord(data);
  if (data.readUInt16LE(endOffset + 4) !== 0 || data.readUInt16LE(endOffset + 6) !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  const entriesOnDisk = data.readUInt16LE(endOffset + 8);
  const totalEntries = data.readUInt16LE(endOffset + 10);
  if (entriesOnDisk !== totalEntries) throw new Error("ZIP entry counts disagree");
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("ZIP central directory bounds are invalid");
  }
  const entries = new Map();
  let offset = centralOffset;
  let expectedLocalOffset = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + centralHeaderSize > endOffset) throw new Error("ZIP central directory is truncated");
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const versionNeeded = data.readUInt16LE(offset + 6);
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const diskStart = data.readUInt16LE(offset + 34);
    const localOffset = data.readUInt32LE(offset + 42);
    if (versionNeeded > 20) throw new Error("ZIP entry requires an unsupported feature version");
    if ((flags & ~0x0800) !== 0) throw new Error("ZIP entry uses unsupported general-purpose flags");
    if (method !== 0) throw new Error("ZIP entry is not stored uncompressed");
    if (compressedSize !== size) throw new Error("ZIP entry sizes disagree");
    if (size === 0xffffffff || compressedSize === 0xffffffff) throw new Error("ZIP64 entries are not supported");
    if (diskStart !== 0) throw new Error("Multi-disk ZIP archives are not supported");
    if (offset + centralHeaderSize + nameLength + extraLength + commentLength > endOffset) {
      throw new Error("ZIP central directory entry exceeds its directory");
    }
    const name = readName(data, offset + centralHeaderSize, nameLength);
    if (entries.has(name)) throw new Error(`Duplicate ZIP entry: ${name}`);
    if (localOffset !== expectedLocalOffset) throw new Error(`ZIP entry data is not contiguous: ${name}`);
    if (localOffset + localHeaderSize > centralOffset) throw new Error(`ZIP local header is out of bounds: ${name}`);
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    if (data.readUInt16LE(localOffset + 4) !== versionNeeded) throw new Error(`ZIP header version mismatch: ${name}`);
    if (data.readUInt16LE(localOffset + 6) !== flags) throw new Error(`ZIP header flag mismatch: ${name}`);
    if (data.readUInt16LE(localOffset + 8) !== method) throw new Error(`ZIP header compression mismatch: ${name}`);
    if (data.readUInt32LE(localOffset + 14) !== crc) throw new Error(`ZIP header CRC mismatch: ${name}`);
    if (data.readUInt32LE(localOffset + 18) !== compressedSize) throw new Error(`ZIP header size mismatch: ${name}`);
    if (data.readUInt32LE(localOffset + 22) !== size) throw new Error(`ZIP header size mismatch: ${name}`);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    if (localNameLength !== nameLength) throw new Error(`ZIP header name mismatch: ${name}`);
    if (localOffset + localHeaderSize + localNameLength + localExtraLength + size > centralOffset) {
      throw new Error(`ZIP entry data is out of bounds: ${name}`);
    }
    const localName = readName(data, localOffset + localHeaderSize, localNameLength);
    if (localName !== name) throw new Error(`ZIP header name mismatch: ${name}`);
    const contentOffset = localOffset + localHeaderSize + localNameLength + localExtraLength;
    const content = data.subarray(contentOffset, contentOffset + size);
    if (crc32(content) !== crc) throw new Error(`CRC mismatch: ${name}`);
    entries.set(name, content);
    expectedLocalOffset = contentOffset + size;
    offset += centralHeaderSize + nameLength + extraLength + commentLength;
  }
  if (offset !== endOffset) throw new Error("ZIP central directory size does not match its entries");
  if (expectedLocalOffset !== centralOffset) throw new Error("ZIP contains data outside its entries");
  return entries;
};
