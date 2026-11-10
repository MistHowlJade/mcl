/**
 * Java 自动管理（痛点 #1–#8 的答案）
 * - 按 MC 版本自动推荐 Java 大版本
 * - 自动检测系统 Java / MCL 已下载的 Java
 * - 缺少时从 Adoptium 下载 Temurin JRE（Windows x64）
 * - 8u291 以下特别提示（TLS 1.3，痛点 #74）
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { javaDir } from './paths';
import { zipExtractAll } from './zip';
import { fetchJson, USER_AGENT } from './net';
import { JavaInfo } from '../shared/types';
import * as http from 'http';
import * as https from 'https';

/** 根据 MC 版本推荐 Java 主版本 */
export function recommendedJavaMajor(mcVersion: string): number {
  const m = mcVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 17;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3] ?? '0', 10);
  if (major === 1) {
    if (minor < 17) return 8;
    if (minor < 20) return 17;
    if (minor === 20 && patch <= 4) return 17;
    return 21;
  }
  return 21;
}

export function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map(x => parseInt(x) || 0);
  const pb = b.split('.').map(x => parseInt(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function runJavaVersion(javaExe: string): Promise<{ version: string; is64: boolean; vendor: string } | null> {
  return new Promise((resolve) => {
    execFile(javaExe, ['-version'], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}\n${stderr ?? ''}`;
      if (err && !out.includes('version')) { resolve(null); return; }
      const m = out.match(/version "([^"]+)"/);
      if (!m) { resolve(null); return; }
      const version = m[1];
      const is64 = /64-Bit/i.test(out);
      let vendor = '未知';
      if (/temurin|adoptium/i.test(out)) vendor = 'Eclipse Temurin';
      else if (/openjdk/i.test(out)) vendor = 'OpenJDK';
      else if (/oracle/i.test(out)) vendor = 'Oracle';
      else if (/zulu/i.test(out)) vendor = 'Azul Zulu';
      else if (/microsoft/i.test(out)) vendor = 'Microsoft';
      else if (/amazon/i.test(out)) vendor = 'Amazon Corretto';
      else if (/bellsoft/i.test(out)) vendor = 'BellSoft Liberty';
      resolve({ version, is64, vendor });
    });
  });
}

function javaMajorFromVersion(v: string): number {
  // "1.8.0_291" → 8；"17.0.7" → 17；"21" → 21
  const m = v.match(/^1\.(\d+)/);
  if (m) return parseInt(m[1], 10);
  const m2 = v.match(/^(\d+)/);
  return m2 ? parseInt(m2[1], 10) : 8;
}

/** Java 8 具体到 update：低于 8u291 不支持 TLS 1.3（痛点 #74） */
export function java8SupportsTls13(version: string): boolean {
  const m = version.match(/^1\.8\.0_(\d+)/);
  if (!m) return true; // 非 8u 系列（更新的 Java）
  return parseInt(m[1], 10) >= 291;
}

async function* walkCandidates(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 3) return;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkCandidates(full, depth + 1);
    } else if (e.name.toLowerCase() === 'java.exe' && /bin/i.test(path.dirname(full))) {
      yield full;
    }
  }
}

export async function detectSystemJavas(): Promise<JavaInfo[]> {
  const seen = new Set<string>();
  const results: JavaInfo[] = [];
  const push = async (exe: string) => {
    const normalized = path.normalize(exe).toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    if (!fs.existsSync(exe)) return;
    const info = await runJavaVersion(exe);
    if (!info) return;
    results.push({
      path: exe,
      version: info.version,
      major: javaMajorFromVersion(info.version),
      vendor: info.vendor,
      is64: info.is64,
      managed: exe.startsWith(javaDir()),
    });
  };

  // 1) MCL 自带
  for await (const exe of walkCandidates(javaDir())) await push(exe);
  // 2) JAVA_HOME / PATH
  if (process.env.JAVA_HOME) await push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of pathDirs) {
    const exe = path.join(d, 'java.exe');
    if (fs.existsSync(exe)) await push(exe);
  }
  // 3) 常见安装位置
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(Boolean) as string[];
  const roots = ['Java', 'Eclipse Adoptium', 'Temurin', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft'];
  for (const pf of programFiles) {
    for (const root of roots) {
      const base = path.join(pf, root);
      for await (const exe of walkCandidates(base)) await push(exe);
    }
  }
  // 去重同一安装（避免太多噪音）：以 major+version+path 排序
  results.sort((a, b) => a.major - b.major || compareVersionDesc(a.version, b.version) || a.path.localeCompare(b.path));
  return results;
}

/** 选出满足推荐主版本的最佳 Java；没有则返回 null（触发自动下载） */
export async function pickJavaFor(mcVersion: string, overridePath?: string | null): Promise<{ java: JavaInfo | null; recommendedMajor: number }> {
  const recommendedMajor = recommendedJavaMajor(mcVersion);
  if (overridePath && fs.existsSync(overridePath)) {
    const info = await runJavaVersion(overridePath);
    if (info) {
      return {
        java: { path: overridePath, version: info.version, major: javaMajorFromVersion(info.version), vendor: info.vendor, is64: info.is64, managed: overridePath.startsWith(javaDir()) },
        recommendedMajor,
      };
    }
  }
  const all = await detectSystemJavas();
  // 精确主版本匹配优先；次选：同主版本最新小版本；Java 8 场景要求 ≥8u291 用于联网
  const exact = all.filter(j => j.major === recommendedMajor);
  const usable = exact.filter(j => j.is64);
  const pool = usable.length ? usable : exact;
  const exactBest = pool.sort((a, b) => compareVersionDesc(a.version, b.version))[0] ?? null;
  if (exactBest) return { java: exactBest, recommendedMajor };
  // 没有匹配：不瞎选，交由下载逻辑
  return { java: null, recommendedMajor };
}

export interface AdoptiumBinary { link: string; size: number; packageName: string }

/** 查询 Adoptium 最新 Temurin JRE（Windows x64） */
export async function getAdoptiumJreUrl(major: number): Promise<AdoptiumBinary | null> {
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
  try {
    const assets = await fetchJson<Array<{ binary: { package: { link: string; size: number; name: string } } }>>(url, { timeoutMs: 15000 });
    const pkg = assets[0]?.binary?.package;
    if (pkg) return { link: pkg.link, size: pkg.size, packageName: pkg.name };
    return null;
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string, onProgress?: (n: number, total: number) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const doGet = (u: string, redirects: number) => {
      const client = u.startsWith('http:') ? http : https;
      const req = client.request(u, { headers: { 'User-Agent': USER_AGENT }, timeout: 30000 }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirects > 5) { reject(new Error('重定向过多')); return; }
          doGet(new URL(res.headers.location, u).toString(), redirects + 1);
          return;
        }
        if (status >= 400) { res.resume(); reject(new Error(`HTTP ${status}：${u}`)); return; }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk: Buffer) => { received += chunk.length; onProgress?.(received, total); });
        res.pipe(out);
        out.on('finish', () => { out.close(); resolve(); });
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Java 下载超时')));
      req.on('error', reject);
      req.end();
    };
    doGet(url, 0);
  });
}

/** 下载并安装 Temurin JRE，返回 java.exe 路径 */
export async function installJava(major: number, onProgress?: (stage: 'fetch' | 'downloading' | 'extracting', received?: number, total?: number) => void): Promise<string> {
  onProgress?.('fetch');
  const info = await getAdoptiumJreUrl(major);
  if (!info) throw new Error(`无法从 Adoptium 获取 Java ${major} 的下载地址`);
  const tmp = path.join(javaDir(), `temurin-${major}-${Date.now()}.zip`);
  fs.mkdirSync(javaDir(), { recursive: true });
  await downloadToFile(info.link, tmp, (r, t) => onProgress?.('downloading', r, t));
  onProgress?.('extracting');
  const destDir = path.join(javaDir(), `temurin-${major}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  const buf = fs.readFileSync(tmp);
  zipExtractAll(buf, destDir);
  fs.rmSync(tmp, { force: true });
  // Temurin zip 内层为 jdk-xx/ 或 jre-xx/ 目录
  const inner = fs.readdirSync(destDir).find(d => fs.statSync(path.join(destDir, d)).isDirectory());
  const home = inner ? path.join(destDir, inner) : destDir;
  const exe = path.join(home, 'bin', 'java.exe');
  if (!fs.existsSync(exe)) throw new Error('Java 安装包结构异常：找不到 bin/java.exe');
  return exe;
}
