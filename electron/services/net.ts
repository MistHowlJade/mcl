/**
 * 网络层：超时控制、重试、镜像映射、镜像测速
 * 痛点 #9/#12/#14/#15/#16 的核心改造点
 */
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { readJson, writeJson } from './store';
import { dataRoot } from './paths';
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
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error(`无法解析的 URL：${url}`)); return; }
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request({
      method: options.method ?? 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) },
      timeout: timeoutMs,
    }, (res) => {
      // 重定向（GET/HEAD 跟随；下载器自行处理断点）
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        fetchWithTimeout(next, { ...options, timeoutMs: options.timeoutMs ? Math.max(1000, timeoutMs - 0) : timeoutMs })
          .then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时（>${timeoutMs}ms）：${url}`)); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
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

/** 把官方下载 URL 映射为镜像地址；official/auto 保持原样 */
export function mapToMirror(url: string, source: 'official' | 'bmclapi' | 'custom', customBase?: string): string {
  const base = source === 'bmclapi' ? BMCLAPI : (source === 'custom' && customBase ? customBase.replace(/\/+$/, '') : null);
  if (!base) return url;
  try {
    const u = new URL(url);
    const host = u.host;
    const pathname = u.pathname;
    if (host.includes('piston-meta.mojang.com') || host.includes('launchermeta.mojang.com')) {
      return `${base}${pathname}`;
    }
    if (host.includes('piston-data.mojang.com')) {
      return `${base}/piston-data${pathname}`;
    }
    if (host.includes('repo.maven.apache.org') || host.includes('maven.minecraft.net') || host.includes('libraries.minecraft.net') || host.includes('libraries.minecraftforge.net') || host.includes('maven.neoforged.net')) {
      return `${base}/libraries${pathname}`;
    }
    if (host.includes('resources.download.minecraft.net')) {
      // BMCLAPI 资源与 2 级目录不同步，直接用 sha1 全路径
      const hash = pathname.split('/').filter(Boolean).pop() ?? '';
      return `${base}/assets/${hash}`;
    }
    if (host.includes('maven.fabricmc.net') || host.includes('maven.quiltmc.org')) {
      return `${base}${pathname}`;
    }
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
