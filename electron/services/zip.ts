/**
 * 零依赖 ZIP 读写（store 与 deflate），供备份 / 整合包导入 / 诊断包使用
 * 避免引入重型依赖，也避免 adm-zip 类的解压炸弹风险（带条目数与大小上限）
 *
 * 两套 API：
 * - zipWrite / zipFromDir / zipList / zipExtractAll：小包用的整块 Buffer API
 * - zipWriteToFile / zipDirToFile：大包用的流式写入，内存占用与包体大小无关；
 *   条目数 > 65535 或总大小 > 4GB 时自动写 ZIP64 结构（#18/#28）。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const U32_MAX = 0xffffffff;
/** 读取侧仍保留安全上限，但不再被 65535/4GB 卡住（zip bomb 兜底） */
const MAX_ENTRIES = 5_000_000;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024 * 1024; // 64GB
/** 整块 Buffer 解压的单条目上限；更大的条目请用流式解压接口 */
const MAX_SYNC_ENTRY = 256 * 1024 * 1024;
const CHUNK_SIZE = 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

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

/** 增量 CRC：流式写入时逐块累计，避免把整个文件读进内存 */
export function crc32Continue(crc: number, buf: Buffer): number {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export function crc32(buf: Buffer): number {
  return (crc32Continue(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function unixMode(name: string): number {
  // 普通文件 0644，脚本/无扩展名可执行文件 0755（便携 ZIP 解压后需可直接运行）
  return (/\.(sh|exe|app)$/i.test(name) || !path.extname(name)) ? 0o100755 : 0o100644;
}

function assertSafeName(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`ZIP 条目名非法（目录穿越）：${name}`);
  }
  return normalized;
}

/* ---------- 整块写（小包） ---------- */
export interface ZipEntryInput {
  name: string;               // 使用 / 分隔的相对路径
  data: Buffer;
  mtime?: Date;
  store?: boolean;            // true = 不压缩（已经压缩过的内容）
}

export function zipWrite(entries: ZipEntryInput[]): Buffer {
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${entries.length} > ${MAX_ENTRIES}）`);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(assertSafeName(entry.name), 'utf8');
    const { time, date } = dosTime(entry.mtime ?? new Date());
    const crc = crc32(entry.data);
    const compressed = entry.store ? entry.data : zlib.deflateRawSync(entry.data, { level: 6 });
    if (entry.data.length > U32_MAX || compressed.length > U32_MAX) {
      throw new Error('单个文件超过 4GB，请使用 zipWriteToFile 流式打包');
    }
    const method = entry.store ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
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
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // version made by：高位 3 = Unix，让 external attrs 的 Unix mode 生效
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
    central.writeUInt32LE(unixMode(entry.name) * 0x10000, 38); // 用乘法，<< 会产生有符号 32 位整数
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  const centralDir = Buffer.concat(centralParts);
  if (centralDir.length > U32_MAX || centralStart > U32_MAX) {
    throw new Error('ZIP 中央目录超过 4GB，请使用 zipWriteToFile 流式打包');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

/* ---------- 流式写（大包 / ZIP64） ---------- */
export interface ZipSourceEntry {
  name: string;               // 相对路径；流式写入时条目来自磁盘文件
  absPath: string;
  mtime?: Date;
  store?: boolean;
  size?: number;              // 已知大小可省一次 stat
}

export interface ZipWriteOptions {
  zip64?: boolean;                                                  // 默认按条目数/大小自动判断
  level?: number;                                                   // deflate 级别，默认 6
  onProgress?: (doneBytes: number, totalBytes: number, name: string) => void;
}

/** 已经压缩过的格式再做 deflate 几乎没收益，直接 store 更快 */
function shouldStore(name: string): boolean {
  return /\.(zip|jar|gz|tgz|png|jpe?g|gif|webp|mca|ogg|mp3|mp4)$/i.test(name);
}

function writeAll(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written);
}

function zip64Extra(uncompressed: number, compressed: number, offset: number, needU: boolean, needC: boolean, needO: boolean): Buffer {
  const fields = [needU, needC, needO].filter(Boolean).length;
  const buf = Buffer.alloc(4 + fields * 8);
  buf.writeUInt16LE(0x0001, 0);
  buf.writeUInt16LE(fields * 8, 2);
  let p = 4;
  if (needU) { buf.writeBigUInt64LE(BigInt(uncompressed), p); p += 8; }
  if (needC) { buf.writeBigUInt64LE(BigInt(compressed), p); p += 8; }
  if (needO) { buf.writeBigUInt64LE(BigInt(offset), p); p += 8; }
  return buf;
}

/**
 * 流式写 ZIP：磁盘文件逐块读取 + 逐块 deflate，内存占用 ≈ 1MB + 条目元数据。
 * 写出的包在需要时带 ZIP64 扩展与 EOCD，可被 MCL 自己的 zipList 和常见解压工具读取。
 */
export async function zipWriteToFile(entries: ZipSourceEntry[], dest: string, options: ZipWriteOptions = {}): Promise<void> {
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${entries.length} > ${MAX_ENTRIES}）`);
  const totalBytes = entries.reduce((sum, e) => {
    const size = e.size ?? fs.statSync(e.absPath).size;
    return sum + size;
  }, 0);
  const zip64 = options.zip64 ?? (entries.length > 0xffff || totalBytes > U32_MAX);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const fd = fs.openSync(dest, 'w');
  let offset = 0;
  let done = 0;
  const centralParts: Buffer[] = [];

  const write = (buf: Buffer) => { writeAll(fd, buf); offset += buf.length; };

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(assertSafeName(entry.name), 'utf8');
      const localOffset = offset;
      // 调用方已经 stat 过（如 zipDirToFile）时可省掉重复系统调用，70k 条目能省一轮 IO
      const stat = (entry.size !== undefined && entry.mtime) ? null : fs.statSync(entry.absPath);
      const rawSize = entry.size ?? stat!.size;
      const mtime = entry.mtime ?? stat!.mtime;
      const { time, date } = dosTime(mtime);
      const store = entry.store ?? shouldStore(entry.name);
      const method = store ? 0 : 8;

      // bit 3 = 使用数据描述符：本地头里 crc/大小先填 0，写完数据再补
      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(zip64 ? 45 : 20, 4);
      local.writeUInt16LE(0x0808, 6);      // UTF-8 + data descriptor
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0, 18);
      local.writeUInt32LE(0, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      write(local);
      write(nameBuf);

      let crc = 0xffffffff;
      let compressedSize = 0;
      const src = fs.openSync(entry.absPath, 'r');
      try {
        const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
        if (store) {
          let read: number;
          while ((read = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
            const part = chunk.subarray(0, read);
            crc = crc32Continue(crc, part);
            write(part);
            compressedSize += read;
          }
        } else {
          const deflate = zlib.createDeflateRaw({ level: options.level ?? 6 });
          deflate.on('data', (out: Buffer) => {
            write(out);
            compressedSize += out.length;
          });
          let read: number;
          while ((read = fs.readSync(src, chunk, 0, chunk.length, null)) > 0) {
            const part = chunk.subarray(0, read);
            crc = crc32Continue(crc, part);
            deflate.write(part);
          }
          await new Promise<void>((resolve, reject) => {
            deflate.once('end', resolve);
            deflate.once('error', reject);
            deflate.end();
          });
        }
      } finally {
        fs.closeSync(src);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const entryZip64 = rawSize > U32_MAX || compressedSize > U32_MAX || localOffset > U32_MAX;
      const descriptor = Buffer.alloc(entryZip64 ? 24 : 16);
      descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
      descriptor.writeUInt32LE(crc, 4);
      if (entryZip64) {
        descriptor.writeBigUInt64LE(BigInt(compressedSize), 8);
        descriptor.writeBigUInt64LE(BigInt(rawSize), 16);
      } else {
        descriptor.writeUInt32LE(compressedSize, 8);
        descriptor.writeUInt32LE(rawSize, 12);
      }
      write(descriptor);

      const needU = rawSize > U32_MAX;
      const needC = compressedSize > U32_MAX;
      const needO = localOffset > U32_MAX;
      const extra = (needU || needC || needO) ? zip64Extra(rawSize, compressedSize, localOffset, needU, needC, needO) : Buffer.alloc(0);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(SIG_CENTRAL, 0);
      central.writeUInt16LE((3 << 8) | (zip64 ? 45 : 20), 4);
      central.writeUInt16LE(zip64 ? 45 : 20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(needC ? U32_MAX : compressedSize, 20);
      central.writeUInt32LE(needU ? U32_MAX : rawSize, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32);        // comment
      central.writeUInt16LE(0, 34);        // disk
      central.writeUInt16LE(0, 36);        // internal attrs
      central.writeUInt32LE(unixMode(entry.name) * 0x10000, 38);
      central.writeUInt32LE(needO ? U32_MAX : localOffset, 42);
      centralParts.push(central, nameBuf, extra);

      done += rawSize;
      options.onProgress?.(done, totalBytes, entry.name);
    }

    const centralStart = offset;
    for (const part of centralParts) write(part);
    const centralSize = offset - centralStart;

    if (zip64) {
      const zip64EocdOffset = offset;
      const z64 = Buffer.alloc(56);
      z64.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      z64.writeBigUInt64LE(44n, 4);        // 之后字段的总长度
      z64.writeUInt16LE((3 << 8) | 45, 12); // version made by
      z64.writeUInt16LE(45, 14);           // version needed
      z64.writeUInt32LE(0, 16);            // disk
      z64.writeUInt32LE(0, 20);            // cd start disk
      z64.writeBigUInt64LE(BigInt(entries.length), 24);
      z64.writeBigUInt64LE(BigInt(entries.length), 32);
      z64.writeBigUInt64LE(BigInt(centralSize), 40);
      z64.writeBigUInt64LE(BigInt(centralStart), 48);
      write(z64);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
      locator.writeUInt32LE(1, 16);
      write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    end.writeUInt32LE(zip64 ? U32_MAX : centralSize, 12);
    end.writeUInt32LE(zip64 ? U32_MAX : centralStart, 16);
    end.writeUInt16LE(0, 20);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
}

/** 流式打包目录（相对 baseDir 的路径为条目名） */
export async function zipDirToFile(
  baseDir: string,
  dest: string,
  filter?: (relPath: string) => boolean,
  options?: ZipWriteOptions,
): Promise<number> {
  const entries: ZipSourceEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) { walk(full, rel); continue; }
      if (!dirent.isFile() || (filter && !filter(rel))) continue;
      try { entries.push({ name: rel, absPath: full, size: fs.statSync(full).size }); }
      catch { /* 文件可能在打包瞬间被删除 */ }
    }
  };
  walk(baseDir, '');
  if (entries.length === 0) throw new Error('目录为空，没有可打包的文件');
  await zipWriteToFile(entries, dest, options);
  return entries.length;
}

/** 流式打包指定文件列表（单个文件读不到时跳过） */
export async function zipFilesToFile(
  files: Array<{ name: string; absPath: string }>,
  dest: string,
  options?: ZipWriteOptions,
): Promise<number> {
  const entries: ZipSourceEntry[] = [];
  for (const f of files) {
    try { entries.push({ name: f.name, absPath: f.absPath, size: fs.statSync(f.absPath).size }); }
    catch { /* 文件可能在打包瞬间被删除 */ }
  }
  if (entries.length === 0) throw new Error('没有可打包的文件');
  await zipWriteToFile(entries, dest, options);
  return entries.length;
}

/* ---------- 读 ---------- */
export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  method: number;
}

interface Zip64DirectoryInfo {
  count: number;
  cdOffset: number;
  cdSize: number;
}

function readZip64Directory(buf: Buffer, eocd: number): Zip64DirectoryInfo | null {
  let zip64Offset = -1;
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
    const candidate = Number(buf.readBigUInt64LE(eocd - 12));
    if (candidate >= 0 && candidate + 56 <= buf.length && buf.readUInt32LE(candidate) === SIG_ZIP64_EOCD) zip64Offset = candidate;
  }
  if (zip64Offset < 0) {
    const start = Math.max(0, eocd - 65536 - 56);
    for (let i = eocd - 56; i >= start; i--) {
      if (buf.readUInt32LE(i) === SIG_ZIP64_EOCD) { zip64Offset = i; break; }
    }
  }
  if (zip64Offset < 0) return null;
  return {
    count: Number(buf.readBigUInt64LE(zip64Offset + 32)),
    cdSize: Number(buf.readBigUInt64LE(zip64Offset + 40)),
    cdOffset: Number(buf.readBigUInt64LE(zip64Offset + 48)),
  };
}

function parseZip64Extra(extra: Buffer, needU: boolean, needC: boolean, needO: boolean): { u?: number; c?: number; o?: number } {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const data = extra.subarray(p + 4, p + 4 + len);
    if (id === 0x0001) {
      let q = 0;
      const res: { u?: number; c?: number; o?: number } = {};
      if (needU) { res.u = Number(data.readBigUInt64LE(q)); q += 8; }
      if (needC) { res.c = Number(data.readBigUInt64LE(q)); q += 8; }
      if (needO) { res.o = Number(data.readBigUInt64LE(q)); }
      return res;
    }
    p += 4 + len;
  }
  throw new Error('ZIP64 条目缺少 0x0001 扩展字段');
}

export function zipList(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new Error('不是有效的 ZIP 文件（文件过小）');
  // 从尾部找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
  const count16 = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize32 = buf.readUInt32LE(eocd + 12);
  let count = count16;
  const sentinel = count16 === 0xffff || cdOffset === U32_MAX || cdSize32 === U32_MAX;
  const zip64 = readZip64Directory(buf, eocd);
  if (sentinel && !zip64) throw new Error('ZIP64 目录损坏（找不到 ZIP64 EOCD）');
  if (zip64) {
    count = zip64.count;
    cdOffset = zip64.cdOffset;
  }
  if (count > MAX_ENTRIES) throw new Error(`ZIP 条目过多（${count} > ${MAX_ENTRIES}）`);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(cdOffset)) throw new Error('ZIP 条目数或偏移超出安全范围');

  const entries: ZipEntry[] = [];
  let ptr = cdOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CENTRAL) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressed32 = buf.readUInt32LE(ptr + 20);
    const uncompressed32 = buf.readUInt32LE(ptr + 24);
    const local32 = buf.readUInt32LE(ptr + 42);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const extra = buf.subarray(ptr + 46 + nameLen, ptr + 46 + nameLen + extraLen);
    const needU = uncompressed32 === U32_MAX;
    const needC = compressed32 === U32_MAX;
    const needO = local32 === U32_MAX;
    const z64 = (needU || needC || needO) ? parseZip64Extra(extra, needU, needC, needO) : {};
    const compressedSize = needC ? z64.c! : compressed32;
    const uncompressedSize = needU ? z64.u! : uncompressed32;
    const localHeaderOffset = needO ? z64.o! : local32;
    if (![compressedSize, uncompressedSize, localHeaderOffset].every(Number.isSafeInteger)) {
      throw new Error('ZIP64 数值超出安全范围');
    }
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) throw new Error('解压后体积超过上限（可能是解压炸弹）');
    entries.push({ name, compressedSize, uncompressedSize, localHeaderOffset, method });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function zipExtractEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_SYNC_ENTRY) {
    throw new Error(`ZIP 条目超过 ${MAX_SYNC_ENTRY / 1024 / 1024}MB，无法整块解压；请改用流式解压接口`);
  }
  const local = entry.localHeaderOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== SIG_LOCAL) {
    throw new Error(`ZIP 本地条目损坏：${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > buf.length) {
    throw new Error(`ZIP 数据区越界：${entry.name}`);
  }
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    // inflateRawSync 必须限制输出：中央目录声明的大小可能是假的（解压炸弹）
    const limit = Math.min(Math.max(entry.uncompressedSize, 1), MAX_SYNC_ENTRY);
    const out = zlib.inflateRawSync(data, { maxOutputLength: limit });
    if (out.length !== entry.uncompressedSize) {
      throw new Error(`ZIP 条目大小不符（声明 ${entry.uncompressedSize}，实际 ${out.length}）：${entry.name}`);
    }
    return out;
  }
  throw new Error(`不支持的压缩方式（method=${entry.method}）：${entry.name}`);
}

export function zipExtractAll(buf: Buffer, destDir: string, stripPrefix?: string): string[] {
  const entries = zipList(buf);
  const written: string[] = [];
  const root = path.resolve(destDir);
  // Windows 打包的 ZIP 条目可能用反斜杠：必须先统一分隔符再做前缀剥离，
  // 否则调用方按 / 计算的前缀（如世界 ZIP 的 world/）永远匹配不上，解压会多套一层目录。
  // 指定前缀时只解压该子树：世界 ZIP 里常夹带截图/备份等无关目录，
  // 原样落进 saves/<世界名>/ 会污染世界目录（甚至让游戏读到不认识的文件）。
  const prefix = (stripPrefix ?? '').replace(/\\/g, '/');
  for (const entry of entries) {
    let rel = entry.name.replace(/\\/g, '/');
    if (prefix) {
      if (!rel.startsWith(prefix)) continue;
      rel = rel.slice(prefix.length);
    }
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

/** 把目录打包成 zip Buffer（相对 baseDir 的路径为条目名）；大目录请用 zipDirToFile */
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

/** 打包指定文件列表（单个文件读不到时跳过，避免日志轮转导致整个诊断包导出失败） */
export function zipFromFiles(files: Array<{ name: string; absPath: string }>): Buffer {
  const entries: ZipEntryInput[] = [];
  for (const f of files) {
    try {
      entries.push({ name: f.name, data: fs.readFileSync(f.absPath) });
    } catch { /* 文件可能在打包瞬间被删除 */ }
  }
  return zipWrite(entries);
}
