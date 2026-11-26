/**
 * 网络层：超时控制、重试、镜像映射、镜像测速
 * 痛点 #9/#12/#14/#15/#16 的核心改造点
 */
import * as http from 'http';
import * as fs from 'fs';
import { URL } from 'url';
import { readJson, writeJson } from './store';
import { dataRoot } from './paths';
import { createProxiedRequest, getApiProxyConfig } from './proxy';
import * as path from 'path';

export const OFFICIAL = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest.json',
  versionManifestV2: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  libraries: 'https://repo.maven.apache.org/maven2',
  librariesLegacy: 'https://libraries.minecraft.net',
  assets: 'https://resources.download.minecraft.net',
} as const;

export const BMCLAPI = 'https://bmclapi2.bangbang93.com';
export const USER_AGENT = 'MCL/0.1.0 (https://github.com/MistHowlJade/mcl)';

const healthFile = () => path.join(dataRoot(), 'cache', 'mirror-health.json');

export interface MirrorHealth { source: 'official' | 'bmclapi'; latencyMs: number; ok: boolean }

export async function fetchWithTimeout(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer | NodeJS.ReadableStream; timeoutMs?: number; redirectDepth?: number; outputFile?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const redirectDepth = options.redirectDepth ?? 0;
  // API/登录/云同步不应受「下载走代理」开关影响，否则关掉下载代理会整体断网
  const req = await createProxiedRequest(url, {
    method: options.method ?? 'GET',
    headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
    timeoutMs,
  }, getApiProxyConfig());
  return new Promise((resolve, reject) => {
    req.on('response', (res) => {
      // 重定向（GET/HEAD 跟随；下载器自行处理断点）
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        // 防止恶意/配置错误的服务器无限重定向
        if (redirectDepth >= 5) {
          reject(new Error(`重定向次数过多：${url}`));
          return;
        }
        let next: URL;
        try { next = new URL(res.headers.location, url); } catch { reject(new Error(`重定向地址无效：${res.headers.location}`)); return; }
        const nextOptions = { ...options, redirectDepth: redirectDepth + 1, timeoutMs };
        // HTTP 303 语义：客户端必须改用 GET，不能带着原 POST body 再请求一次
        if (status === 303) {
          nextOptions.method = 'GET';
          delete nextOptions.body;
        }
        // 跨域重定向时不携带 Authorization，避免 WebDAV/令牌被转到第三方主机
        try {
          if (new URL(url).origin !== next.origin && nextOptions.headers) {
            const headers = { ...nextOptions.headers };
            delete headers.Authorization;
            delete headers.authorization;
            nextOptions.headers = headers;
          }
        } catch { /* 原 URL 解析失败时保持原样 */ }
        fetchWithTimeout(next.toString(), nextOptions).then(resolve, reject);
        return;
      }
      if (options.outputFile) {
        // 大文件下载（云快照）直接落盘，避免 res.body 把整包留在内存
        try { fs.mkdirSync(path.dirname(options.outputFile), { recursive: true }); } catch (e) { reject(e); return; }
        const out = fs.createWriteStream(options.outputFile);
        out.once('error', reject);
        res.once('error', (e) => { out.destroy(); reject(e); });
        out.once('finish', () => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }));
        res.pipe(out);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body) {
      const body = options.body;
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        req.end(body);
      } else {
        // 大文件上传（云同步 ZIP）用流，避免再把整包读进内存
        body.on('error', reject).pipe(req);
      }
    } else req.end();
  });
}

export async function fetchJson<T>(url: string, options?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<T> {
  const res = await fetchWithTimeout(url, { timeoutMs: options?.timeoutMs ?? 20000, headers: { Accept: 'application/json', ...(options?.headers ?? {}) } });
  if (res.status === 401 || res.status === 403) throw new HttpError(res.status, `无权限（HTTP ${res.status}）`);
  if (res.status >= 400) throw new HttpError(res.status, `HTTP ${res.status}：${url}`);
  try {
    return JSON.parse(res.body.toString('utf8')) as T;
  } catch {
    throw new Error(`返回内容不是合法 JSON：${url}`);
  }
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'HttpError'; }
}

/**
 * 从异常里提取能展示给玩家的原因。
 * Node 双栈（happy-eyeballs）连接全部失败时会抛 AggregateError：
 * name=AggregateError、code=ETIMEDOUT、message="" —— 直接拼 message 会得到「：。」这种空文案。
 * 这里依次尝试：message → 子错误 → code → name，保证文案非空且不带技术性对象序列化。
 */
export function errorReason(e: unknown, depth = 0): string {
  if (e instanceof Error) {
    const message = e.message.trim();
    if (message) return message;
    if (depth < 2 && e instanceof AggregateError) {
      const parts = e.errors.map(inner => errorReason(inner, depth + 1)).filter(Boolean);
      if (parts.length) return parts.join('；');
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code) return `连接失败（${code}）`;
    if (e.name && e.name !== 'Error') return `连接失败（${e.name}）`;
  }
  const text = String(e).trim();
  return text && text !== 'Error' && text !== 'null' && text !== 'undefined' ? text : '未知错误';
}

/** 把官方下载 URL 映射为镜像地址；official/auto 保持原样 */
export function mapToMirror(url: string, source: 'official' | 'bmclapi' | 'custom', customBase?: string): string {
  const base = source === 'bmclapi' ? BMCLAPI : (source === 'custom' && customBase ? customBase.replace(/\/+$/, '') : null);
  if (!base) return url;
  try {
    const u = new URL(url);
    const host = u.host;
    const pathname = u.pathname;
    // 签名 / 缓存参数必须保留，否则映射后的 URL 会失效
    const suffix = `${u.search}${u.hash}`;
    if (host.includes('piston-meta.mojang.com') || host.includes('launchermeta.mojang.com')) {
      return `${base}${pathname}${suffix}`;
    }
    if (host.includes('piston-data.mojang.com')) {
      // BMCLAPI：/piston-data 前缀是多余的（404），保留原路径即可
      return `${base}${pathname}${suffix}`;
    }
    if (host.includes('repo.maven.apache.org') || host.includes('libraries.minecraft.net') || host.includes('maven.minecraft.net')) {
      // 官方仓库路径带 /maven2 前缀，BMCLAPI 的 /libraries 下不需要
      const rel = pathname.replace(/^\/maven2\//, '/');
      return `${base}/libraries${rel}${suffix}`;
    }
    if (host.includes('resources.download.minecraft.net')) {
      // BMCLAPI 资源与 2 级目录不同步，直接用 sha1 全路径
      const hash = pathname.split('/').filter(Boolean).pop() ?? '';
      return `${base}/assets/${hash}${suffix}`;
    }
    if (host.includes('maven.fabricmc.net') || host.includes('maven.quiltmc.org')) {
      // BMCLAPI 的 Fabric/Quilt Maven 在 /maven 前缀下，直接拼原路径会 404
      return `${base}/maven${pathname}${suffix}`;
    }
    // Forge/NeoForge Maven 不在 BMCLAPI 上，不映射（走官方小文件即可）
    return url;
  } catch {
    return url;
  }
}

export async function measureMirror(url: string, timeoutMs = 6000): Promise<number> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: 'GET', timeoutMs, headers: { Range: 'bytes=0-0' } });
    if (res.status >= 400) return Number.MAX_SAFE_INTEGER;
    return Date.now() - start;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 测速两个源并记忆最快选择（auto 模式用） */
export async function pickBestSource(customMirror?: string): Promise<{ source: 'official' | 'bmclapi' | 'custom'; latencies: MirrorHealth[] }> {
  const testUrl = OFFICIAL.versionManifestV2;
  const [officialLatency, bmclapiLatency] = await Promise.all([
    measureMirror(testUrl),
    measureMirror(`${BMCLAPI}/mc/game/version_manifest_v2.json`),
  ]);
  const latencies: MirrorHealth[] = [
    { source: 'official', latencyMs: officialLatency, ok: officialLatency < 60000 },
    { source: 'bmclapi', latencyMs: bmclapiLatency, ok: bmclapiLatency < 60000 },
  ];
  writeJson(healthFile(), { at: Date.now(), latencies });
  let source: 'official' | 'bmclapi' = 'official';
  if (bmclapiLatency < officialLatency) source = 'bmclapi';
  return { source, latencies };
}

export function lastHealthCheck(): { at: number; latencies: MirrorHealth[] } | null {
  return readJson(healthFile(), null as { at: number; latencies: MirrorHealth[] } | null);
}
