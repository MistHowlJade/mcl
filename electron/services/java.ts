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
import { createProxiedRequest } from './proxy';
import { JavaInfo } from '../shared/types';

/** 根据 MC 版本推荐 Java 主版本 */
export function recommendedJavaMajor(mcVersion: string): number {
  // IPC/配置里的版本号可能是非字符串：不能让它把 .match 抛错带崩检测
  if (typeof mcVersion !== 'string') return 17;
  // 快照号（如 24w14a）没有点号，旧逻辑直接落回 17，会让 1.20.5+ 快照用错 Java
  const snap = mcVersion.match(/^(\d+)w/);
  if (snap) {
    const year = parseInt(snap[1], 10);
    return year >= 26 ? 25 : year >= 24 ? 21 : 17;
  }
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
  // 2026 年起的新版本号方案（26.x），Mojang 要求 Java 25
  return major >= 26 ? 25 : 21;
}

/** 把版本号拆成可比较数组：Java 8 的 1.8.0_291 必须比 1.8.0_202 新 */
function versionParts(v: string): number[] {
  const update = v.trim().match(/^1\.8\.0_(\d+)/);
  if (update) return [1, 8, 0, parseInt(update[1], 10)];
  return v.split('.').map(x => parseInt(x, 10) || 0);
}

export function compareVersionDesc(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
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

// macOS 的 JVM 多一层 Contents/Home（系统 JVM 与 MCL 自管 JRE 都是），
// 深度限制太小会找不到刚下载好的 Java，导致下一次启动又重新下载一遍。
const MAX_WALK_DEPTH = process.platform === 'darwin' ? 5 : 3;

async function* walkCandidates(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const exe = javaExeName();
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkCandidates(full, depth + 1);
    } else if (e.name.toLowerCase() === exe.toLowerCase() && /bin/i.test(path.dirname(full))) {
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
  if (process.env.JAVA_HOME) await push(path.join(process.env.JAVA_HOME, 'bin', javaExeName()));
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of pathDirs) {
    const exe = path.join(d, javaExeName());
    if (fs.existsSync(exe)) await push(exe);
  }
  // 3) 常见安装位置
  if (isWinPlatform) {
    const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(Boolean) as string[];
    const roots = ['Java', 'Eclipse Adoptium', 'Temurin', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft'];
    for (const pf of programFiles) {
      for (const root of roots) {
        for await (const exe of walkCandidates(path.join(pf, root))) await push(exe);
      }
    }
  } else {
    const unixRoots = process.platform === 'darwin'
      ? ['/Library/Java/JavaVirtualMachines', '/opt/homebrew/opt', '/usr/local/opt']
      : ['/usr/lib/jvm', '/usr/lib/jdk', '/opt/java', '/opt/jdk', '/opt/openjdk', '/usr/local/lib/jvm'];
    for (const root of unixRoots) {
      for await (const exe of walkCandidates(root)) await push(exe);
    }
  }
  // 去重同一安装（避免太多噪音）：以 major+version+path 排序
  results.sort((a, b) => a.major - b.major || compareVersionDesc(a.version, b.version) || a.path.localeCompare(b.path));
  return results;
}

/** 选出满足推荐主版本的最佳 Java；没有则返回 null（触发自动下载） */
export async function pickJavaFor(mcVersion: string, overridePath?: string | null, requiredMajor?: number | null): Promise<{ java: JavaInfo | null; recommendedMajor: number }> {
  // 版本 JSON 的 javaVersion.majorVersion 是权威值，优先于按版本号推导的兜底
  const recommendedMajor = Number.isInteger(requiredMajor) && (requiredMajor as number) > 0
    ? requiredMajor as number
    : recommendedJavaMajor(mcVersion);
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

export interface AdoptiumBinary { link: string; size: number; packageName: string; isTarGz: boolean }

const isWinPlatform = process.platform === 'win32';
const javaExeName = () => (isWinPlatform ? 'java.exe' : 'java');
const adoptiumOS = () => (isWinPlatform ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');
const adoptiumArch = () => (process.arch === 'arm64' ? 'aarch64' : 'x64');

/** 查询 Adoptium 最新 Temurin JRE（当前平台） */
export async function getAdoptiumJreUrl(major: number): Promise<AdoptiumBinary | null> {
  const url = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${adoptiumArch()}&image_type=jre&os=${adoptiumOS()}&vendor=eclipse`;
  try {
    const assets = await fetchJson<Array<{ binary: { package: { link: string; size: number; name: string } } }>>(url, { timeoutMs: 15000 });
    const pkg = assets[0]?.binary?.package;
    if (pkg) return { link: pkg.link, size: pkg.size, packageName: pkg.name, isTarGz: /\.tar\.gz$|\.tgz$/i.test(pkg.name ?? pkg.link ?? '') };
    return null;
  } catch {
    return null;
  }
}

async function downloadToFile(url: string, dest: string, onProgress?: (n: number, total: number) => void, redirects = 0): Promise<void> {
  if (redirects > 5) throw new Error('Java 下载重定向过多');
  const req = await createProxiedRequest(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: 60000,
  });
  await new Promise<void>((resolve, reject) => {
    req.once('response', (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        let next: string;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          reject(new Error(`Java 下载服务器返回了非法的重定向地址：${String(res.headers.location).slice(0, 200)}`));
          return;
        }
        downloadToFile(next, dest, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (status >= 400) { res.resume(); reject(new Error(`HTTP ${status}：${url}`)); return; }
      const total = parseInt(res.headers['content-length'] ?? '0', 10);
      let received = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk: Buffer) => { received += chunk.length; onProgress?.(received, total); });
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
      out.on('finish', () => { out.close(); resolve(); });
      res.pipe(out);
    });
    req.once('error', reject);
    req.end();
  }).catch((e) => {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw e;
  });
}

/** 下载并安装 Temurin JRE，返回 java 可执行文件路径 */
export async function installJava(major: number, onProgress?: (stage: 'fetch' | 'downloading' | 'extracting', received?: number, total?: number) => void): Promise<string> {
  // 主版本会进入 Adoptium URL 与本地目录名：必须是合理整数，否则可被拼出 ../ 路径
  if (!Number.isInteger(major) || major < 8 || major > 30) throw new Error('Java 主版本不合法（只支持 8–30）');
  onProgress?.('fetch');
  const info = await getAdoptiumJreUrl(major);
  if (!info) throw new Error(`无法从 Adoptium 获取 Java ${major} 的下载地址`);
  fs.mkdirSync(javaDir(), { recursive: true });
  const ext = info.isTarGz ? '.tar.gz' : '.zip';
  const tmp = path.join(javaDir(), `temurin-${major}-${Date.now()}${ext}`);
  await downloadToFile(info.link, tmp, (r, t) => onProgress?.('downloading', r, t));
  if (Number.isFinite(info.size) && info.size > 0) {
    const actual = fs.statSync(tmp).size;
    if (actual !== info.size) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw new Error(`Java 安装包下载不完整（期望 ${info.size} 字节，实际 ${actual} 字节），请重试或检查网络/代理。`);
    }
  }
  onProgress?.('extracting');
  // 先解压到临时目录并校验成功，再替换旧 JRE：
  // 直接删除旧目录会在下载/解压失败时把玩家原本能用的 Java 一起弄没。
  const destDir = path.join(javaDir(), `temurin-${major}`);
  const stagingDir = path.join(javaDir(), `temurin-${major}-staging-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  let innerRel = '';
  try {
    if (info.isTarGz) {
      // Linux/macOS 的 Temurin 发行包是 tar.gz，用系统 tar 解压（保留可执行位）
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', tmp, '-C', stagingDir], { timeout: 120000 }, (err) => err ? reject(new Error(`tar 解压失败：${err.message}`)) : resolve());
      });
    } else {
      zipExtractAll(fs.readFileSync(tmp), stagingDir);
    }
    // Temurin 包内层为 jdk-xx/ 或 jre-xx/ 目录；macOS 的可执行文件在 Contents/Home/bin 下
    const inner = fs.readdirSync(stagingDir).find(d => fs.statSync(path.join(stagingDir, d)).isDirectory());
    const roots = inner ? [inner, ''] : [''];
    const candidates = roots.flatMap(root => [
      path.join(root, 'Contents', 'Home', 'bin', javaExeName()),
      path.join(root, 'bin', javaExeName()),
    ]);
    const found = candidates.find(rel => fs.existsSync(path.join(stagingDir, rel)));
    if (!found) {
      throw new Error(`Java 安装包结构异常：找不到 bin/${javaExeName()}`);
    }
    innerRel = found;
    const backupDir = `${destDir}.old-${Date.now()}`;
    const hadOld = fs.existsSync(destDir);
    if (hadOld) fs.renameSync(destDir, backupDir);
    try {
      fs.renameSync(stagingDir, destDir);
    } catch (e) {
      if (hadOld) { try { fs.renameSync(backupDir, destDir); } catch { /* 还原失败时至少保留备份目录 */ } }
      throw e;
    }
    if (hadOld) { try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 清理失败不影响使用 */ } }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    try { if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const exe = path.join(destDir, innerRel);
  try { fs.chmodSync(exe, 0o755); } catch { /* Windows 无需 chmod */ }
  return exe;
}
