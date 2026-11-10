/**
 * 零依赖 ZIP 读写（store 与 deflate），供备份 / 整合包导入 / 诊断包使用
 * 避免引入重型依赖，也避免 adm-zip 类的解压炸弹风险（带条目数与大小上限）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const MAX_ENTRIES = 20000;
const MAX_TOTAL_UNCOMPRESSED = 4 * 1024 * 1024 * 1024; // 4GB

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------- 写 ---------- */
export interface ZipEntryInput {
  name: string;               // 使用 / 分隔的相对路径
  data: Buffer;
  mtime?: Date;
  store?: boolean;            // true = 不压缩（已经压缩过的内容）
}

export function zipWrite(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const dosTime = (d: Date) => {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  };

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const mtime = entry.mtime ?? new Date();
    const { time, date } = dosTime(mtime);
    const crc = crc32(entry.data);
    const compressed = entry.store ? entry.data : zlib.deflateRawSync(entry.data, { level: 6 });
    const method = entry.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra len
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0x0800, 8);    // UTF-8 flag
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk
    central.writeUInt16LE(0, 36);        // internal attrs
    central.writeUInt32LE(0, 38);        // external attrs
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

/* ---------- 读 ---------- */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  method: number;
}

export function zipList(buf: Buffer): ZipEntry[] {
  // 从尾部找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${count} > ${MAX_ENTRIES}）`);

  const entries: ZipEntry[] = [];
  let ptr = cdOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('解压后体积超过上限（可能是解压炸弹）');
    entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function zipExtractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`ZIP 本地条目损坏：${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方式（method=${entry.method}）：${entry.name}`);
}

export function zipExtractAll(buf: Buffer, destDir: string, stripPrefix?: string): string[] {
  const entries = zipList(buf);
  const written: string[] = [];
  const root = path.resolve(destDir);
  for (const entry of entries) {
    let rel = entry.name;
    if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
    rel = rel.replace(/\\/g, '/');
    if (!rel || rel.endsWith('/')) continue;
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new Error(`ZIP 包含非法路径（目录穿越）：${entry.name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zipExtractEntry(buf, entry));
    written.push(target);
  }
  return written;
}

/** 把目录打包成 zip Buffer（相对 baseDir 的路径为条目名） */
export function zipFromDir(baseDir: string, filter?: (relPath: string) => boolean): Buffer {
  const entries: ZipEntryInput[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) { walk(full, rel); continue; }
      if (filter && !filter(rel)) continue;
      entries.push({ name: rel, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
    }
  };
  walk(baseDir, '');
  return zipWrite(entries);
}

/** 打包指定文件列表 */
export function zipFromFiles(files: Array<{ name: string; absPath: string }>): Buffer {
  return zipWrite(files.map(f => ({ name: f.name, data: fs.readFileSync(f.absPath) })));
}
