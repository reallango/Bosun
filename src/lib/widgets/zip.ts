/**
 * Minimal zip reader/writer (stored and deflate entries) so widget packages can be imported and
 * exported without another dependency. The reader is defensive: it only trusts the central
 * directory, caps entry counts and sizes (zip bombs), rejects unsafe names and encryption.
 */
import zlib from 'zlib';

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 60, maxEntryBytes: 512 * 1024, maxTotalBytes: 2 * 1024 * 1024 };

let crcTable: Uint32Array | null = null;
export function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Names that could escape the extraction folder or are otherwise surprising. */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.includes('\0')) return false;
  return !name.split('/').some(s => s === '..' || s === '.');
}

export function writeZip(entries: Record<string, string | Uint8Array>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01, so output is reproducible
  for (const [name, data] of Object.entries(entries)) {
    const raw = Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    const deflated = zlib.deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export class ZipError extends Error {}

/** Read a zip into `{ name: bytes }`. Directories are skipped. Throws ZipError on anything unsafe or malformed. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Record<string, Buffer> {
  // End of central directory record: the last 22+ bytes, signature 0x06054b50.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > limits.maxEntries) throw new ZipError(`The zip has more than ${limits.maxEntries} entries`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('The zip is damaged');

  const out: Record<string, Buffer> = {};
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('The zip is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry
    if (!isSafeEntryName(name)) throw new ZipError(`Unsafe file name in the zip: ${name.slice(0, 60)}`);
    if (flags & 1) throw new ZipError('Encrypted zips are not supported');
    if (name in out) throw new ZipError(`Duplicate file in the zip: ${name}`);
    if (usize > limits.maxEntryBytes) throw new ZipError(`"${name}" is larger than ${Math.round(limits.maxEntryBytes / 1024)} KB`);
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError('The zip expands to too much data');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError('The zip is damaged');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + csize > buf.length) throw new ZipError('The zip is damaged');
    const body = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) {
      try { data = zlib.inflateRawSync(body, { maxOutputLength: limits.maxEntryBytes + 1 }); } catch { throw new ZipError(`"${name}" could not be unpacked`); }
    } else throw new ZipError(`"${name}" uses an unsupported compression method`);
    if (data.length !== usize || crc32(data) !== crc) throw new ZipError(`"${name}" failed its integrity check`);
    out[name] = data;
  }
  return out;
}
