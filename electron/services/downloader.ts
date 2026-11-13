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
import { mapToMirror, USER_AGENT } from './net';
import { createProxiedRequest } from './proxy';

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

export class DownloadManager extends EventEmitter {
  private tasks: DownloadTask[] = [];
  private opts: Required<DownloadOptions>;
  private canceled = false;
  private active = 0;
  private reports: TaskReport[] = [];
  private bytesDoneAll = 0;
  private bytesTotalAll = 0;

  constructor(opts: DownloadOptions) {
    super();
    this.opts = {
      source: opts.source,
      customMirror: opts.customMirror ?? '',
      maxThreads: Math.max(1, Math.min(64, opts.maxThreads)),
      segmentSizeMB: Math.max(1, opts.segmentSizeMB ?? 4),
      retries: Math.max(0, opts.retries ?? 3),
      timeoutMs: Math.max(3000, opts.timeoutMs ?? 15000),
    };
  }

  cancel(): void {
    this.canceled = true;
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
          const next = new URL(res.headers.location, url).toString();
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
      stream.on('data', (chunk: Buffer) => { onChunk(chunk.length); });
      stream.pipe(out);
      out.on('finish', () => { out.close(); resolve(); });
      out.on('error', reject);
      stream.on('error', (e) => { out.destroy(); reject(e); });
    });
  }

  private async downloadTask(task: DownloadTask): Promise<TaskReport> {
    const name = task.name ?? path.basename(task.dest);
    const partFile = path.join(cacheDir(), `dl-${safeId(task.id + task.url)}.part`);
    const dest = task.dest;

    // 已完成且校验通过 → 直接复用
    if (fs.existsSync(dest)) {
      if (!task.sha1) {
        this.bytesDoneAll += fs.statSync(dest).size;
        return { id: task.id, name, ok: true, bytes: fs.statSync(dest).size, fromCache: true };
      }
      try {
        const hash = await sha1File(dest);
        if (hash === task.sha1.toLowerCase()) {
          this.bytesDoneAll += fs.statSync(dest).size;
          return { id: task.id, name, ok: true, bytes: fs.statSync(dest).size, fromCache: true };
        }
      } catch { /* fallthrough：损坏就重下 */ }
    }

    const sources = this.mirrorUrls(task);
    let lastError = '未知错误';
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      if (this.canceled) return { id: task.id, name, ok: false, bytes: 0, error: '已取消', fromCache: false };
      const url = sources[attempt % sources.length];
      const isAlt = attempt >= sources.length;
      try {
        // 一次 HEAD 探测：大小 + 是否支持 Range
        const threshold = this.opts.segmentSizeMB * 1024 * 1024;
        const h = await this.head(url);
        let total = task.size ?? 0;
        if (!total && fs.existsSync(partFile)) total = fs.statSync(partFile).size;
        if (total === 0) {
          total = h.size;
          if (total > 0) this.bytesTotalAll += h.size;
        }

        if (total > threshold && !isAlt && h.acceptsRanges) {
          try {
            await this.segmentedDownload(url, partFile, total, (n) => this.addProgress(task, n));
          } catch (e) {
            // 服务器返回 200（不支持 Range）→ 退化为单流下载，不浪费重试次数
            if (e instanceof Error && e.message === 'RANGE_UNSUPPORTED') {
              await this.streamToFile(url, partFile, (n) => this.addProgress(task, n));
            } else {
              throw e;
            }
          }
        } else {
          await this.streamToFile(url, partFile, (n) => this.addProgress(task, n));
        }
        // 统一落盘到目标路径
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (fs.existsSync(partFile)) {
          fs.renameSync(partFile, dest);
        } else if (!fs.existsSync(dest)) {
          throw new Error('下载未产生文件');
        }

        // 校验
        if (task.sha1) {
          const hash = await sha1File(dest);
          if (hash !== task.sha1.toLowerCase()) {
            fs.rmSync(dest, { force: true });
            fs.rmSync(partFile, { force: true });
            throw new Error('文件校验失败（SHA-1 不匹配），正在尝试备用源');
          }
        }
        const bytes = fs.statSync(dest).size;
        return { id: task.id, name, ok: true, bytes, fromCache: false };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        // 失败后清理当前 part，换源重试
        if (attempt < this.opts.retries) {
          try { fs.rmSync(partFile, { force: true }); } catch { /* ignore */ }
        }
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
    for (let i = 0; i < segCount; i++) {
      const start = i * segSize;
      const end = Math.min(total - 1, (i + 1) * segSize - 1);
      if (start > end) continue;
      const segFile = `${partFile}.seg${i}`;
      segFiles.push(segFile);
      const existing = fs.existsSync(segFile) ? fs.statSync(segFile).size : 0;
      const actualStart = start + existing;
      workers.push((async () => {
        const { status, stream } = await this.requestWithRedirects(url, { method: 'GET', headers: { Range: `bytes=${actualStart}-${end}` } });
        if (status === 200) {
          stream.resume();
          throw new Error('RANGE_UNSUPPORTED');
        }
        if (status !== 206 && status !== 200) {
          stream.resume();
          throw new Error(`HTTP ${status}（分段 ${i}）`);
        }
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(segFile, { flags: existing > 0 ? 'a' : 'w' });
          stream.on('data', (chunk: Buffer) => onChunk(chunk.length));
          stream.pipe(out);
          out.on('finish', () => { out.close(); resolve(); });
          out.on('error', reject);
          stream.on('error', (e) => { out.destroy(); reject(e); });
        });
      })());
    }
    try {
      await Promise.all(workers);
    } catch (e) {
      if (e instanceof Error && e.message === 'RANGE_UNSUPPORTED') {
        for (const seg of segFiles) fs.rmSync(seg, { force: true });
        throw e;
      }
      throw e;
    }
    // 拼接
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
    for (const seg of segFiles) fs.rmSync(seg, { force: true });
  }

  private progressMap = new Map<string, number>();

  private addProgress(task: DownloadTask, n: number): void {
    this.bytesDoneAll += n;
    const cur = (this.progressMap.get(task.id) ?? 0) + n;
    this.progressMap.set(task.id, cur);
    this.emit('progress', task, cur);
  }

  async run(tasks: DownloadTask[]): Promise<TaskReport[]> {
    this.tasks = tasks;
    this.bytesDoneAll = 0;
    this.bytesTotalAll = tasks.reduce((acc, t) => acc + (t.size ?? 0), 0);
    this.reports = [];
    this.canceled = false;
    this.active = 0;
    const queue = [...tasks];
    let cursor = 0;

    return new Promise((resolve) => {
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
          });
        }
        if (this.active === 0 && cursor >= queue.length) resolve(this.reports);
      };
      tryNext();
    });
  }

  get totals(): { done: number; total: number } {
    return { done: this.bytesDoneAll, total: this.bytesTotalAll };
  }
}
