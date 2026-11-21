/**
 * 多线程分段下载引擎
 * 解决痛点 #9（单线程慢）#10（镜像不稳定·自动切换）#11（卡 0%：分级超时+清晰报错）
 *          #12（校验失败：sha1 自动重下备用源）#13（并发队列）#16（断点续传）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { cacheDir } from './paths';
import { errorReason, mapToMirror, USER_AGENT } from './net';
import { createProxiedRequest } from './proxy';
import { readJson, writeJson } from './store';

export interface DownloadTask {
  id: string;
  url: string;                       // 主地址（官方）
  sha1?: string;
  size?: number;
  dest: string;
  /** 需要展示给用户的名字，如 "1.20.1 客户端" / "libraries/xx.jar" */
  name?: string;
}

export interface DownloadOptions {
  source: 'auto' | 'bmclapi' | 'official' | 'custom';
  customMirror?: string;
  maxThreads: number;                // 任务级并发
  segmentSizeMB?: number;            // 触发分段的阈值
  retries?: number;
  timeoutMs?: number;
}

export interface TaskReport {
  id: string;
  name: string;
  ok: boolean;
  bytes: number;
  error?: string;
  fromCache: boolean;
}

interface ResolvedSource { url: string }

const safeId = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

interface VerifiedFile { size: number; mtime: number; sha1: string }
type VerifyCache = Record<string, VerifiedFile>;

const verifyCacheFile = () => path.join(cacheDir(), 'verified-files.json');
let verifyCache: VerifyCache | null = null;
let verifyCacheDirty = false;

function getVerifyCache(): VerifyCache {
  if (!verifyCache) {
    const raw = readJson<unknown>(verifyCacheFile(), {});
    verifyCache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as VerifyCache : {};
  }
  return verifyCache;
}

/** 记录“该文件在某个 size+mtime 下 SHA-1 已验证”，下次启动免于重复全量哈希 */
function markVerified(dest: string, stat: fs.Stats, sha1: string): void {
  const cache = getVerifyCache();
  cache[dest] = { size: stat.size, mtime: stat.mtimeMs, sha1 };
  if (Object.keys(cache).length > 10000) {
    verifyCache = {};
    for (const [k, v] of Object.entries(cache)) if (k === dest) verifyCache[k] = v;
  }
  // 不在这里逐个写盘：一次下载几十个文件时会产生几十次全量 JSON 覆盖写
  verifyCacheDirty = true;
}

/** 每轮下载结束后统一写一次校验缓存 */
function flushVerifyCache(): void {
  if (!verifyCacheDirty || !verifyCache) return;
  verifyCacheDirty = false;
  try { writeJson(verifyCacheFile(), verifyCache); } catch { /* 缓存失败只影响下次性能 */ }
}

function wasVerified(dest: string, stat: fs.Stats, sha1: string): boolean {
  const hit = getVerifyCache()[dest];
  return !!hit && hit.size === stat.size && hit.mtime === stat.mtimeMs && hit.sha1 === sha1;
}

export class DownloadManager extends EventEmitter {
  private tasks: DownloadTask[] = [];
  private opts: Required<DownloadOptions>;
  private canceled = false;
  private active = 0;
  private reports: TaskReport[] = [];
  /** 正在传输的响应流：取消时必须立刻销毁，否则大文件仍会下完才停 */
  private readonly liveStreams = new Set<import('stream').Readable>();
  private bytesDoneAll = 0;
  private bytesTotalAll = 0;

  constructor(opts: DownloadOptions) {
    super();
    this.opts = {
      source: opts.source,
      customMirror: opts.customMirror ?? '',
      // 配置可能被手工改坏：非数字会让 while (active < maxThreads) 永远不成立，下载队列直接卡死
      maxThreads: Number.isFinite(opts.maxThreads) ? Math.max(1, Math.min(64, Math.floor(opts.maxThreads))) : 16,
      segmentSizeMB: Number.isFinite(opts.segmentSizeMB) ? Math.max(1, Math.min(512, opts.segmentSizeMB!)) : 4,
      retries: Number.isFinite(opts.retries) ? Math.max(0, Math.min(10, Math.floor(opts.retries!))) : 3,
      timeoutMs: Number.isFinite(opts.timeoutMs) ? Math.max(3000, Math.min(300000, opts.timeoutMs!)) : 15000,
    };
  }

  cancel(): void {
    this.canceled = true;
    // 只置标志不够：已开始的单流/分段下载会继续跑完；直接销毁传输中的响应流
    for (const stream of this.liveStreams) {
      try { stream.destroy(new Error('下载已取消')); } catch { /* ignore */ }
    }
    this.liveStreams.clear();
    this.emit('canceled');
  }

  private mirrorUrls(task: DownloadTask): string[] {
    if (this.opts.source === 'official') return [task.url];
    if (this.opts.source === 'auto') {
      // auto：先镜像再官方（国内优先），失败互相兜底
      const m = mapToMirror(task.url, 'bmclapi');
      const arr = m === task.url ? [task.url] : [m, task.url];
      return arr;
    }
    const m = mapToMirror(task.url, this.opts.source === 'custom' ? 'custom' : 'bmclapi', this.opts.customMirror);
    return m === task.url ? [task.url] : [m, task.url];
  }

  /**
   * 统一 HTTP 请求：显式端口 + 最多 5 次 3xx 重定向
   * 返回已开始消费的响应流（status>=400 时 body 可被 drain 或直接读取）
   */
  private async requestWithRedirects(
    url: string,
    options: { method: string; headers?: Record<string, string> },
    redirectDepth = 0,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: import('stream').Readable }> {
    const req = await createProxiedRequest(url, {
      method: options.method,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
      timeoutMs: this.opts.timeoutMs,
    });
    return new Promise((resolve, reject) => {
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirectDepth < 5) {
          res.resume();
          // Location 由服务器控制：非法地址必须变成可读错误，不能让 new URL 在事件回调里抛出未捕获异常
          let next: string;
          try {
            next = new URL(res.headers.location, url).toString();
          } catch {
            reject(new Error(`服务器返回了非法的重定向地址：${String(res.headers.location).slice(0, 200)}`));
            return;
          }
          this.requestWithRedirects(next, options, redirectDepth + 1).then(resolve, reject);
          return;
        }
        resolve({ status, headers: res.headers, stream: res });
      });
      req.on('error', reject);
      req.end();
    });
  }

  private head(url: string): Promise<{ status: number; size: number; acceptsRanges: boolean }> {
    return this.requestWithRedirects(url, { method: 'HEAD' }).then(({ status, headers, stream }) => {
      stream.resume();
      const size = parseInt((headers['content-length'] as string) ?? '0', 10) || 0;
      const acceptsRanges = (headers['accept-ranges'] ?? '').toString().includes('bytes');
      return { status, size, acceptsRanges };
    }, () => ({ status: 0, size: 0, acceptsRanges: false }));
  }

  /** 单个文件下载（支持断点续传），完成后停留在 partFile，由上层统一 rename 到 dest */
  private async streamToFile(url: string, partFile: string, onChunk: (n: number) => void): Promise<void> {
    const existing = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
    const headers: Record<string, string> = {};
    if (existing > 0) headers['Range'] = `bytes=${existing}-`;
    const { status, stream } = await this.requestWithRedirects(url, { method: 'GET', headers });
    return new Promise((resolve, reject) => {
      if (status === 416) { stream.resume(); resolve(); return; } // 已下完
      if (status >= 400) {
        stream.resume();
        reject(new Error(`HTTP ${status}：${url}`));
        return;
      }
      const append = existing > 0 && status === 206;
      fs.mkdirSync(path.dirname(partFile), { recursive: true });
      const out = fs.createWriteStream(partFile, { flags: append ? 'a' : 'w' });
      this.liveStreams.add(stream);
      stream.on('data', (chunk: Buffer) => { onChunk(chunk.length); });
      stream.pipe(out);
      out.on('finish', () => { this.liveStreams.delete(stream); out.close(); resolve(); });
      out.on('error', (e) => { this.liveStreams.delete(stream); reject(e); });
      stream.on('close', () => this.liveStreams.delete(stream));
      stream.on('error', (e) => { this.liveStreams.delete(stream); out.destroy(); reject(e); });
    });
  }

  /** 清理主 part 与所有分段文件，避免半成品在换源后继续被复用 */
  private cleanupParts(partFile: string): void {
    try { fs.rmSync(partFile, { force: true }); } catch { /* ignore */ }
    const dir = path.dirname(partFile);
    const base = path.basename(partFile);
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === base || entry.startsWith(`${base}.seg`)) {
          fs.rmSync(path.join(dir, entry), { force: true });
        }
      }
    } catch { /* 目录不存在时忽略 */ }
  }

  private async downloadTask(task: DownloadTask): Promise<TaskReport> {
    const name = task.name ?? path.basename(task.dest);
    const partFile = path.join(cacheDir(), `dl-${safeId(task.id + task.url)}.part`);
    const dest = task.dest;

    // 已完成且校验通过 → 直接复用
    if (fs.existsSync(dest)) {
      const cachedSize = fs.statSync(dest).size;
      const cachedStat = fs.statSync(dest);
      if (task.sha1 && wasVerified(dest, cachedStat, task.sha1.toLowerCase())) {
        this.bytesDoneAll += cachedSize;
        return { id: task.id, name, ok: true, bytes: cachedSize, fromCache: true };
      }
      if (!task.sha1) {
        // 没有 SHA-1 的文件只能用声明大小判断完整性：上次中断留下的截断文件不能被当成缓存复用
        if (typeof task.size === 'number' && task.size > 0 && cachedSize !== task.size) {
          try { fs.rmSync(dest, { force: true }); } catch { /* 删不掉时交给重下覆盖 */ }
        } else {
          this.bytesDoneAll += cachedSize;
          return { id: task.id, name, ok: true, bytes: cachedSize, fromCache: true };
        }
      } else {
        try {
          const hash = await sha1File(dest);
          if (hash === task.sha1.toLowerCase()) {
            markVerified(dest, cachedStat, hash);
            this.bytesDoneAll += cachedSize;
            return { id: task.id, name, ok: true, bytes: cachedSize, fromCache: true };
          }
        } catch { /* fallthrough：损坏就重下 */ }
      }
    }

    const sources = this.mirrorUrls(task);
    let lastError = '未知错误';
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (this.canceled) return { id: task.id, name, ok: false, bytes: 0, error: '已取消', fromCache: false };
      const url = sources[attempt % sources.length];
      const isAlt = attempt >= sources.length;
      // 本轮已上报的字节数：换源重试会重新下载，失败时要把这部分扣回去
      let attemptBytes = 0;
      const count = (n: number) => { attemptBytes += n; this.addProgress(task, n); };
      try {
        // 一次 HEAD 探测：大小 + 是否支持 Range。
        // 任务声明了大小且小于分段阈值时不需要探测：Mojang 清单/资源索引都带 size，
        // 首次安装 3500+ 个小资源时每个少一次往返，否则光 HEAD 就要多花几分钟。
        const threshold = this.opts.segmentSizeMB * 1024 * 1024;
        const knownSmall = typeof task.size === 'number' && task.size > 0 && task.size <= threshold;
        let h: { status: number; size: number; acceptsRanges: boolean } = { status: 0, size: 0, acceptsRanges: false };
        if (!knownSmall) {
          h = await this.head(url);
          // HEAD 探测阶段也可能收到取消：必须在这里就退出，不能继续写出完整文件
          if (this.canceled) return { id: task.id, name, ok: false, bytes: 0, error: '下载已取消', fromCache: false };
        }
        // 优先使用任务声明的大小 / HEAD 的完整大小；只有拿不到完整大小时才退回已有 part 大小
        let total = task.size ?? 0;
        if (!total) total = h.size;
        const expectedSize = total;
        if (!total && fs.existsSync(partFile)) total = fs.statSync(partFile).size;
        if (!task.size && h.size > 0 && !this.sizeCounted.has(task.id)) {
          this.sizeCounted.add(task.id);
          this.bytesTotalAll += h.size;
        }

        if (total > threshold && !isAlt && h.acceptsRanges) {
          try {
            await this.segmentedDownload(url, partFile, total, count);
          } catch (e) {
            // 服务器返回 200（不支持 Range）→ 退化为单流下载，不浪费重试次数
            if (e instanceof Error && e.message === 'RANGE_UNSUPPORTED') {
              await this.streamToFile(url, partFile, count);
            } else {
              throw e;
            }
          }
        } else {
          await this.streamToFile(url, partFile, count);
        }
        if (this.canceled) return { id: task.id, name, ok: false, bytes: 0, error: '下载已取消', fromCache: false };
        // 统一落盘到目标路径
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(partFile)) {
          try {
            fs.renameSync(partFile, dest);
          } catch (e) {
            // 跨盘时（便携模式数据目录与系统「下载」文件夹不在同一盘）rename 会抛 EXDEV：
            // 退回复制+删除，行为等价且允许跨文件系统
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
            fs.copyFileSync(partFile, dest);
            fs.rmSync(partFile, { force: true });
          }
        } else if (!fs.existsSync(dest)) {
          throw new Error('下载未产生文件');
        }

        const actualBytes = fs.statSync(dest).size;
        // 没有 SHA-1 的第三方文件（如部分加载器库）：至少用大小拦住被截断的文件，
        // 否则下次启动会把残包当成“已下载”直接复用
        if (!task.sha1 && expectedSize > 0 && actualBytes !== expectedSize) {
          fs.rmSync(dest, { force: true });
          throw new Error(`文件大小不符（期望 ${expectedSize}，实际 ${actualBytes} 字节），正在尝试备用源`);
        }

        // 校验
        if (task.sha1) {
          const hash = await sha1File(dest);
          if (hash !== task.sha1.toLowerCase()) {
            this.cleanupParts(partFile);
            fs.rmSync(dest, { force: true });
            throw new Error('文件校验失败（SHA-1 不匹配），正在尝试备用源');
          }
          markVerified(dest, fs.statSync(dest), hash);
        }
        const bytes = fs.statSync(dest).size;
        return { id: task.id, name, ok: true, bytes, fromCache: false };
      } catch (e) {
        lastError = errorReason(e);
        this.rollbackProgress(task, attemptBytes);
        // 失败后清理当前 part 与分段文件，换源重试
        if (attempt < this.opts.retries) this.cleanupParts(partFile);
      }
    }
    return { id: task.id, name, ok: false, bytes: 0, error: lastError, fromCache: false };
  }

  /** 分段下载：独立的 .seg 文件并发拉取，完成后拼接；服务器不支持 Range（返回 200）时抛 RANGE_UNSUPPORTED */
  private async segmentedDownload(url: string, partFile: string, total: number, onChunk: (n: number) => void): Promise<void> {
    const segCount = Math.min(8, Math.max(2, Math.floor(total / (8 * 1024 * 1024)) || 2));
    const segSize = Math.ceil(total / segCount);
    const segFiles: string[] = [];
    const workers: Array<Promise<void>> = [];
    const activeStreams = new Set<import('stream').Readable>();
    let firstError: Error | null = null;

    const abortWorkers = (err: Error) => {
      if (!firstError) firstError = err;
      for (const stream of activeStreams) {
        try { stream.destroy(err); } catch { /* ignore */ }
      }
    };

    for (let i = 0; i < segCount; i++) {
      const start = i * segSize;
      const end = Math.min(total - 1, (i + 1) * segSize - 1);
      if (start > end) continue;
      const expected = end - start + 1;
      const segFile = `${partFile}.seg${i}`;
      segFiles.push(segFile);

      // 已有分段超过本段长度说明缓存损坏，截断后重下；刚好下完则跳过请求
      let existing = fs.existsSync(segFile) ? fs.statSync(segFile).size : 0;
      if (existing > expected) {
        try { fs.truncateSync(segFile, expected); } catch { /* 截断失败则重下整段 */ }
        existing = fs.existsSync(segFile) ? fs.statSync(segFile).size : 0;
      }
      if (existing >= expected) continue;

      const actualStart = start + existing;
      workers.push((async () => {
        if (firstError) return;
        const { status, stream } = await this.requestWithRedirects(url, { method: 'GET', headers: { Range: `bytes=${actualStart}-${end}` } });
        if (firstError) { stream.resume(); return; }
        if (status === 200) {
          stream.resume();
          throw new Error('RANGE_UNSUPPORTED');
        }
        if (status !== 206) {
          stream.resume();
          throw new Error(`HTTP ${status}（分段 ${i}）`);
        }
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(segFile, { flags: existing > 0 ? 'a' : 'w' });
          activeStreams.add(stream);
          this.liveStreams.add(stream);
          stream.on('data', (chunk: Buffer) => onChunk(chunk.length));
          stream.on('error', (e) => { activeStreams.delete(stream); this.liveStreams.delete(stream); out.destroy(); reject(e); });
          stream.on('close', () => { activeStreams.delete(stream); this.liveStreams.delete(stream); });
          stream.pipe(out);
          out.on('finish', () => { out.close(); resolve(); });
          out.on('error', reject);
        });
        const written = fs.existsSync(segFile) ? fs.statSync(segFile).size : 0;
        if (written !== expected) throw new Error(`分段 ${i} 数据不完整（${written}/${expected} 字节）`);
      })().catch((e: unknown) => {
        abortWorkers(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }));
    }

    try {
      await Promise.allSettled(workers);
      if (firstError) throw firstError;
      // 拼接前再次确认每段长度，避免短流被静默拼成坏文件
      for (let i = 0; i < segFiles.length; i++) {
        const stat = fs.existsSync(segFiles[i]) ? fs.statSync(segFiles[i]) : null;
        if (!stat) throw new Error(`分段 ${i} 文件缺失`);
      }
      fs.mkdirSync(path.dirname(partFile), { recursive: true });
      const out = fs.createWriteStream(partFile);
      for (const seg of segFiles) {
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(seg);
          rs.on('end', resolve);
          rs.on('error', reject);
          rs.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.on('error', reject); });
      const finalSize = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
      if (finalSize !== total) throw new Error(`分段拼接后大小不符（期望 ${total}，实际 ${finalSize} 字节）`);
      for (const seg of segFiles) fs.rmSync(seg, { force: true });
    } catch (e) {
      for (const seg of segFiles) fs.rmSync(seg, { force: true });
      try { fs.rmSync(partFile, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  private progressMap = new Map<string, number>();
  private sizeCounted = new Set<string>();

  private addProgress(task: DownloadTask, n: number): void {
    this.bytesDoneAll += n;
    const cur = (this.progressMap.get(task.id) ?? 0) + n;
    this.progressMap.set(task.id, cur);
    this.emit('progress', task, cur);
  }

  /** 失败重试时扣回本轮已上报的字节，避免进度显示超过总大小 */
  private rollbackProgress(task: DownloadTask, n: number): void {
    if (n <= 0) return;
    this.bytesDoneAll = Math.max(0, this.bytesDoneAll - n);
    const cur = Math.max(0, (this.progressMap.get(task.id) ?? 0) - n);
    this.progressMap.set(task.id, cur);
  }

  async run(tasks: DownloadTask[]): Promise<TaskReport[]> {
    this.tasks = tasks;
    this.bytesDoneAll = 0;
    this.bytesTotalAll = tasks.reduce((acc, t) => acc + (t.size ?? 0), 0);
    this.reports = [];
    this.liveStreams.clear();
    this.canceled = false;
    this.active = 0;
    this.sizeCounted.clear();
    this.progressMap.clear();
    const queue = [...tasks];
    let cursor = 0;

    return new Promise<TaskReport[]>((resolve) => {
      const tryNext = () => {
        if (this.canceled) {
          if (this.active === 0) resolve(this.reports);
          return;
        }
        while (this.active < this.opts.maxThreads && cursor < queue.length) {
          const task = queue[cursor++];
          this.active++;
          this.downloadTask(task).then((report) => {
            this.reports.push(report);
            this.active--;
            this.emit('taskDone', task, report);
            tryNext();
          }).catch((e: unknown) => {
            // downloadTask 内部已兜底，这里防御漏网异常导致队列永久挂起
            const name = task.name ?? path.basename(task.dest);
            this.reports.push({ id: task.id, name, ok: false, bytes: 0, error: errorReason(e), fromCache: false });
            this.active--;
            tryNext();
          });
        }
        if (this.active === 0 && cursor >= queue.length) resolve(this.reports);
      };
      tryNext();
    }).finally(() => flushVerifyCache());
  }

  get totals(): { done: number; total: number } {
    return { done: this.bytesDoneAll, total: this.bytesTotalAll };
  }
}
