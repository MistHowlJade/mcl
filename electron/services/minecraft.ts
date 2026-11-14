/**
 * 游戏启动管线
 * 解决痛点 #1/#2/#4/#5（Java 自动匹配，绝不瞎选）#12（库校验失败→自动重下）#25（闪退人话归因）
 *          #31（残余进程自动清理）#32（原生库按次唯一目录，规避 lwjgl.dll 被占用）#58（一键修复代替关校验）
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import * as paths from './paths';
import * as settingsService from './settings';
import * as javaService from './java';
import * as authService from './auth';
import * as versionService from './version';
import { DownloadManager, sha1File } from './downloader';
import { zipExtractEntry, zipList } from './zip';
import { getSettings } from './settings';
import { proxyJvmArgs } from './proxy';
import { getInstance, touchPlayed, updateInstance } from './instances';
import { analyzeCrash } from './crash';
import { EventEmitter } from 'events';
import { fetchJson } from './net';
import { LoaderType, MemoryPreset } from '../shared/types';

export const launchEvents = new EventEmitter();

/** 已有实例在启动/运行时拒绝二次启动（用于区分"本次启动失败"与"别的实例正在运行"） */
export class LaunchBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchBusyError';
  }
}

export const launchState = {
  instanceId: null as string | null,
  status: 'idle' as 'idle' | 'preparing' | 'downloading' | 'launching' | 'running' | 'crashed' | 'exited',
  pid: null as number | null,
  message: '',
  progress: null as { done: number; total: number } | null,
};

const MEMORY_PRESETS: Record<MemoryPreset, { initial: string; max: string; gc: string[]; label: string }> = {
  low: { initial: '1G', max: '2G', gc: [], label: '低配机器' },
  standard: { initial: '2G', max: '4G', gc: [], label: '标准（大部分整合包）' },
  heavy: {
    initial: '4G', max: '8G', label: '大型整合包 / 光影',
    gc: ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'],
  },
};

const safeRmDir = (dir: string) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

/** 启动前：清理本启动器上次异常退出残留的游戏进程（痛点 #31） */
export async function killResidualProcesses(): Promise<number[]> {
  const file = paths.residualPidsFile();
  const pids = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as number[] : [];
  const killed: number[] = [];
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const alive = await new Promise<boolean>((resolve) => {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        resolve(!err && (stdout ?? '').includes(String(pid)));
      });
    });
    if (alive) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true }, () => resolve());
      });
      killed.push(pid);
    }
  }
  fs.writeFileSync(file, '[]', 'utf8');
  return killed;
}

function trackPid(pid: number): void {
  const file = paths.residualPidsFile();
  let pids: number[] = [];
  try { pids = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as number[] : []; } catch { pids = []; }
  pids.push(pid);
  fs.writeFileSync(file, JSON.stringify(pids), 'utf8');
}

function untrackPid(pid: number): void {
  const file = paths.residualPidsFile();
  try {
    const pids = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as number[]).filter(p => p !== pid) : [];
    fs.writeFileSync(file, JSON.stringify(pids), 'utf8');
  } catch { /* ignore */ }
}

/** 校验共享库完整性（一键修复的核心，替代"关闭文件校验"这个危险民间技巧 #58） */
export function findCorruptedLibraries(resolved: Record<string, any>, gameLibsDir: string): Array<{ path: string; expected?: string; dest: string }> {
  const corrupted: Array<{ path: string; expected?: string; dest: string }> = [];
  const libs = versionService.collectLibraries(resolved);
  for (const lib of libs) {
    const shared = path.join(paths.librariesDir(), ...lib.path.split('/'));
    const gameLocal = path.join(gameLibsDir, ...lib.path.split('/'));
    const dest = fs.existsSync(shared) ? shared : gameLocal;
    if (!fs.existsSync(dest)) { corrupted.push({ path: lib.path, expected: lib.sha1, dest }); continue; }
    if (lib.sha1) {
      // 只对较小文件做同步快速校验，避免启动前卡太久；大的 native 也可接受
      const stat = fs.statSync(dest);
      if (stat.size === 0) corrupted.push({ path: lib.path, expected: lib.sha1, dest });
    }
  }
  return corrupted;
}

/** 提取 natives 到唯一目录（痛点 #56/#128：lwjgl.dll 被占用） */
export function extractNatives(resolved: Record<string, any>, targetDir: string): void {
  safeRmDir(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const libs = versionService.collectLibraries(resolved).filter(l => l.isNative);
  for (const lib of libs) {
    const shared = path.join(paths.librariesDir(), ...lib.path.split('/'));
    if (!fs.existsSync(shared)) continue;
    const buf = fs.readFileSync(shared);
    let entries;
    try { entries = zipList(buf); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('META-INF/')) continue;
      if (entry.name.endsWith('/')) continue;
      try {
        const out = path.join(targetDir, path.basename(entry.name));
        fs.writeFileSync(out, zipExtractEntry(buf, entry));
      } catch { /* 单个 native 失败不致命 */ }
    }
  }
}

const TOKEN_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(TOKEN_REGEX, (_, key) => vars[key] ?? '');
}

function argValueTokens(value: any, vars: Record<string, string>): string[] {
  if (typeof value === 'string') return [substitute(value, vars)];
  if (Array.isArray(value)) return value.flatMap(v => argValueTokens(v, vars));
  return [];
}

function evalArgRules(entry: any, features: Record<string, boolean>): boolean {
  if (!entry || typeof entry !== 'object') return true;
  const rules = entry.rules as versionService.Rule[] | undefined;
  return versionService.evalRules(rules, features);
}

/** 一键修复：重新校验并修复损坏的库/资源文件（替代危险的"关闭文件校验"技巧，痛点 #57/#58） */
export async function repairLibraries(instanceId: string): Promise<{ checked: number; repaired: number; failed: number }> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const settings = getSettings();
  const manifest = await versionService.getVersionManifest(settings.download.source, settings.download.customMirror);
  const entry = manifest.versions.find(v => v.id === instance.mcVersion);
  if (!entry) throw new Error(`版本清单中找不到 ${instance.mcVersion}`);
  const plan = await versionService.buildDownloadPlan(entry, settings.download.source, settings.download.customMirror);
  const repairable = plan.tasks.filter(t => t.sha1);
  const corrupted: typeof repairable = [];
  for (const t of repairable) {
    if (!fs.existsSync(t.dest)) continue; // 缺失的文件交给下次启动统一下载
    const hash = await sha1File(t.dest).catch(() => null);
    if (hash && hash !== t.sha1!.toLowerCase()) corrupted.push(t);
  }
  if (corrupted.length === 0) return { checked: repairable.length, repaired: 0, failed: 0 };
  const dl = new DownloadManager({ source: settings.download.source, customMirror: settings.download.customMirror, maxThreads: 4, retries: 3, timeoutMs: settings.download.timeoutMs });
  const reports = await dl.run(corrupted.map(t => ({ ...t, id: `repair:${t.id}` })));
  return { checked: repairable.length, repaired: reports.filter(r => r.ok).length, failed: reports.filter(r => !r.ok).length };
}

/** 一键修复：清空 natives 唯一目录的旧残留 */
export function reextractNatives(instanceId: string): void {
  safeRmDir(paths.nativesRoot(instanceId));
  fs.mkdirSync(paths.nativesRoot(instanceId), { recursive: true });
}

export interface LaunchOptions { accountId?: string | null }

/** 读取/下载加载器 profile（fabric/quilt），合并进基础版本 */
async function resolveLoaderProfile(base: Record<string, any>, loader: LoaderType, loaderVersion: string | null | undefined, mcVersion: string): Promise<Record<string, any>> {
  if (loader === 'vanilla') return base;
  if (loader === 'fabric') {
    const lv = loaderVersion ?? (await latestFabricLoader(mcVersion));
    const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${lv}/profile/json`;
    try {
      const profile = await fetchJson<Record<string, any>>(url, { timeoutMs: 20000 });
      return versionService.mergeProfile(base, profile);
    } catch (e) {
      throw new Error(`Fabric 加载器 profile 获取失败：${url}\n${e instanceof Error ? e.message : e}\n请检查 loader 版本是否存在（如 fabric-loader 0.15.7 + MC 1.20.1）。`);
    }
  }
  if (loader === 'quilt') {
    const lv = loaderVersion ?? (await latestQuiltLoader(mcVersion));
    const url = `https://meta.quiltmc.org/v3/versions/loader/${mcVersion}/${lv}/profile/json`;
    try {
      const profile = await fetchJson<Record<string, any>>(url, { timeoutMs: 20000 });
      return versionService.mergeProfile(base, profile);
    } catch (e) {
      throw new Error(`Quilt 加载器 profile 获取失败：${url}\n${e instanceof Error ? e.message : e}\n请检查 loader 版本是否存在（如 quilt-loader 0.23.1 + MC 1.20.1）。`);
    }
  }
  if (loader === 'forge' || loader === 'neoforge') {
    // Forge 系需要安装器生成版本 json；此处返回带 customVersionDir 标记的基础版本，
    // 由 ensureForgeInstalled 处理
    return { ...base, __forgeLoader: loader, __loaderVersion: loaderVersion };
  }
  return base;
}

async function latestFabricLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<Array<{ loader: { version: string }; intermediary: { version: string } }>>(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`, { timeoutMs: 20000 });
  if (!list?.length) throw new Error(`Fabric 不支持 Minecraft ${mcVersion}（请确认该版本有 Fabric 移植）`);
  return list[0].loader.version;
}

async function latestQuiltLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<Array<{ loader: { version: string } }>>(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`, { timeoutMs: 20000 });
  if (!list?.length) throw new Error(`Quilt 不支持 Minecraft ${mcVersion}`);
  return list[0].loader.version;
}

/** 解析 Maven maven-metadata.xml，返回全部 <version> 文本 */
async function fetchMavenVersions(url: string): Promise<string[]> {
  const { fetchWithTimeout } = await import('./net');
  const res = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (res.status >= 400) throw new Error(`Maven 元数据不可用（HTTP ${res.status}）：${url}`);
  const xml = res.body.toString('utf8');
  return Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g)).map(m => m[1].trim());
}

/** NeoForge 版本号前缀：MC 1.20.1 → "20.1."；1.21 → "21."；1.21.4 → "21.4." */
function neoForgePrefix(mcVersion: string): string {
  // NeoForge 1.20.1 沿用 Forge 的 47.x 版本号
  if (mcVersion === '1.20.1') return '47.';
  return mcVersion.replace(/^1\./, '').replace(/\.0$/, '') + '.';
}

/** Forge/NeoForge：下载安装器并静默安装到实例目录（使用实例自己的 libraries 目录） */
async function ensureForgeLikeInstalled(gameDir: string, loader: 'forge' | 'neoforge', mcVersion: string, loaderVersion: string | null | undefined, javaPath: string, emit: (line: string) => void): Promise<string> {
  const versionsDirRel = path.join(gameDir, 'versions');
  const existingFilter = (d: string) => loader === 'neoforge' ? /neoforge/i.test(d) : /forge/i.test(d);
  const existing = fs.existsSync(versionsDirRel) ? fs.readdirSync(versionsDirRel).filter(existingFilter) : [];
  if (existing.length > 0 && loaderVersion) {
    const hit = existing.find(d => d.includes(loaderVersion));
    if (hit) return path.join(versionsDirRel, hit, `${hit}.json`);
  }

  let forgeId: string;
  let installerUrl: string;
  if (loaderVersion) {
    // 已指定版本：不请求元数据，直接下载安装器
    if (loader === 'forge') {
      forgeId = loaderVersion.includes('-') ? loaderVersion : `${mcVersion}-${loaderVersion}`;
      installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeId}/forge-${forgeId}-installer.jar`;
    } else {
      forgeId = loaderVersion;
      installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${forgeId}/neoforge-${forgeId}-installer.jar`;
    }
  } else if (loader === 'forge') {
    const versions = await fetchMavenVersions('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
    const matching = versions.filter(v => v.startsWith(`${mcVersion}-`));
    if (matching.length === 0) throw new Error(`Maven 中找不到适用于 ${mcVersion} 的 Forge 版本，请在创建实例时手动指定加载器版本。`);
    forgeId = matching[matching.length - 1];
    installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeId}/forge-${forgeId}-installer.jar`;
  } else {
    const versions = await fetchMavenVersions('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const prefix = neoForgePrefix(mcVersion);
    const matching = versions.filter(v => v.startsWith(prefix));
    if (matching.length === 0) throw new Error(`NeoForge 中找不到适用于 ${mcVersion} 的版本（前缀 ${prefix}），请在创建实例时手动指定加载器版本。`);
    forgeId = matching[matching.length - 1];
    installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${forgeId}/neoforge-${forgeId}-installer.jar`;
  }

  const installerPath = path.join(gameDir, `.${loader}-installer.jar`);
  emit(`正在下载 ${loader === 'neoforge' ? 'NeoForge' : 'Forge'} 安装器（${forgeId}）…`);
  const { DownloadManager: DM } = await import('./downloader');
  const dl = new DM({ source: 'official', maxThreads: 1, retries: 2 });
  const reports = await dl.run([{ id: 'loader-installer', url: installerUrl, dest: installerPath, name: `${loader} 安装器` }]);
  if (!reports[0]?.ok) throw new Error(`${loader} 安装器下载失败：${reports[0]?.error ?? '未知错误'}\nURL：${installerUrl}`);
  emit('正在静默安装（可能需要 1–5 分钟，期间会打印安装日志）…');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installerPath, '--installClient', gameDir], { cwd: gameDir, windowsHide: true });
    child.stdout.on('data', d => emit(`[installer] ${String(d).trim()}`));
    child.stderr.on('data', d => emit(`[installer] ${String(d).trim()}`));
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${loader} 安装器退出码 ${code}`)));
    child.on('error', reject);
  });
  fs.rmSync(installerPath, { force: true });
  const installed = fs.existsSync(versionsDirRel) ? fs.readdirSync(versionsDirRel).filter(d => loader === 'neoforge' ? /neoforge/i.test(d) : /forge/i.test(d)) : [];
  const hit = installed[0];
  if (!hit) throw new Error(`${loader} 安装完成但找不到版本目录，请查看安装日志。`);
  return path.join(versionsDirRel, hit, `${hit}.json`);
}

export async function launchInstance(instanceId: string, options: LaunchOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const emitStatus = (status: typeof launchState.status, message = '') => {
    launchState.status = status;
    launchState.message = message;
    launchEvents.emit('status', { ...launchState });
  };
  // 校验顺序：先做实例与 unknown 版本检查，再做并发保护（避免两种错误叠加时给出错误提示）
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (instance.mcVersion === 'unknown') {
    throw new Error('该实例未识别 MC 版本，请先在「实例」页设置版本后再启动。');
  }
  // 并发保护：已有实例在启动/运行中时拒绝二次启动（防双进程、防误杀正在运行的游戏）
  const busyStates = ['preparing', 'downloading', 'launching', 'running'];
  if (busyStates.includes(launchState.status) && launchState.instanceId) {
    throw new LaunchBusyError('已有实例在启动/运行中，请等待其退出后再试。');
  }
  // 从这里开始本次启动接管状态；后续任何失败都由 IPC 层回退为 idle
  launchState.instanceId = instanceId;
  launchState.pid = null;
  const gameLogSafe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');
  // 本次启动唯一日志文件（避免跨启动累积导致旧错误被当成本次错误，见 issue #9）
  const launchLogName = `launch-${gameLogSafe(instanceId)}-${startedAt}.log`;
  const emitLog = (line: string) => {
    launchEvents.emit('log', line);
    try {
      fs.mkdirSync(paths.logsDir(), { recursive: true });
      fs.appendFileSync(path.join(paths.logsDir(), launchLogName), line + '\n', 'utf8');
    } catch { /* ignore */ }
  };

  const settings = getSettings();
  const activeAccountId = options.accountId ?? authService.getActiveAccount()?.id ?? null;
  if (!activeAccountId) throw new Error('还没有选择账号。请先在「账号」页登录微软账号或创建离线账号。');

  emitStatus('preparing', '正在准备游戏…');

  // 1) 残余进程（痛点 #31）
  if (settings.launch.autoKillResidual) {
    const killed = await killResidualProcesses();
    if (killed.length > 0) emitLog(`[mcl] 已清理 ${killed.length} 个残余游戏进程`);
  }

  // 2) 版本清单定位
  const manifest = await versionService.getVersionManifest(settings.download.source, settings.download.customMirror);
  const entry = manifest.versions.find(v => v.id === instance.mcVersion);
  if (!entry) throw new Error(`版本清单中找不到 ${instance.mcVersion}`);

  // 3) Java（痛点 #1/#4/#5/#7）
  let javaPath = instance.javaPath ?? (settings.java.defaultPath || null);
  let javaInfo = await javaService.pickJavaFor(instance.mcVersion, javaPath);
  if (!javaInfo.java) {
    emitStatus('preparing', `未找到 Java ${javaInfo.recommendedMajor}，正在自动下载（约 45 MB）…`);
    const exe = await javaService.installJava(javaInfo.recommendedMajor, (stage, received, total) => {
      if (stage === 'downloading' && received && total) {
        emitStatus('preparing', `正在下载 Java ${javaInfo.recommendedMajor} … ${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`);
      }
    });
    javaPath = exe;
    javaInfo = await javaService.pickJavaFor(instance.mcVersion, exe);
  }
  const java = javaInfo.java!;
  emitLog(`[mcl] 使用 Java：${java.path}（${java.version}, ${java.is64 ? '64 位' : '32 位'}, ${java.vendor}）`);
  if (!java.is64) emitLog('[mcl] 警告：检测到 32 位 Java，单个实例最多只能使用约 1.5 GB 内存。建议安装 64 位 Java。');
  if (java.major === 8 && !javaService.java8SupportsTls13(java.version)) {
    emitLog('[mcl] 警告：Java 8 低于 8u291 不支持 TLS 1.3，连接微软验证服务器可能失败。建议更新 Java 8 到 8u291+。');
  }

  // 4) 解析版本 json + 加载器
  emitStatus('preparing', '正在解析版本结构…');
  let resolved = await versionService.resolveVersion(entry, settings.download.source, settings.download.customMirror);
  if (instance.loader !== 'vanilla') {
    if (instance.loader === 'forge' || instance.loader === 'neoforge') {
      const jsonPath = await ensureForgeLikeInstalled(paths.gameDir(instanceId), instance.loader, instance.mcVersion, instance.loaderVersion, java.path, emitLog);
      const profile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      resolved = versionService.mergeProfile(resolved, profile);
    } else {
      resolved = await resolveLoaderProfile(resolved, instance.loader, instance.loaderVersion, instance.mcVersion);
    }
  }

  // 5) 下载/校验缺失文件（一键修复复用，痛点 #12/#57）
  emitStatus('downloading', '正在检查并下载游戏文件…');
  const gameLibsDir = path.join(paths.gameDir(instanceId), 'libraries');
  const plan = await versionService.buildDownloadPlan(entry, settings.download.source, settings.download.customMirror);
  // 合并加载器 profile 的库
  const profileLibs = versionService.collectLibraries(resolved).filter(l => !plan.tasks.some(t => t.dest.endsWith(l.path.replace(/\//g, path.sep))));
  for (const l of profileLibs) {
    plan.tasks.push({ id: `lib:${l.path}`, url: l.url, sha1: l.sha1, size: l.size, dest: path.join(paths.librariesDir(), ...l.path.split('/')), name: path.basename(l.path) });
  }
  const dl = new DownloadManager({
    source: settings.download.source,
    customMirror: settings.download.customMirror,
    maxThreads: settings.download.maxThreads,
    segmentSizeMB: settings.download.segmentSizeMB,
    timeoutMs: settings.download.timeoutMs,
    retries: settings.download.retries,
  });
  const totalBytes = plan.tasks.reduce((a, t) => a + (t.size ?? 0), 0);
  let doneBytes = 0;
  const onProgress = () => {
    doneBytes = dl.totals.done;
    launchState.progress = { done: doneBytes, total: Math.max(totalBytes, doneBytes, 1) };
    launchEvents.emit('progress', launchState.progress);
  };
  dl.on('progress', onProgress);
  const reports = await dl.run(plan.tasks);
  const failed = reports.filter(r => !r.ok);
  if (failed.length > 0) {
    const preview = failed.slice(0, 3).map(f => `${f.name}：${f.error}`).join('\n');
    throw new Error(`有 ${failed.length} 个文件下载失败：\n${preview}${failed.length > 3 ? '\n…' : ''}\n\n可尝试切换下载源后重试（设置 → 下载 → 镜像源）。`);
  }

  // 6) 库完整性校验（sha1 抽检，太大跳过）——不杀泛滥：这里只报告
  const corrupted = findCorruptedLibraries(resolved, gameLibsDir);
  if (corrupted.length > 0) {
    emitLog(`[mcl] 警告：检测到 ${corrupted.length} 个可能损坏的库文件，将尝试重新下载`);
    const repair = new DownloadManager({ source: settings.download.source, customMirror: settings.download.customMirror, maxThreads: 4, retries: 2, timeoutMs: settings.download.timeoutMs });
    await repair.run(corrupted.map(c => {
      const lib = versionService.collectLibraries(resolved).find(l => l.path === c.path)!;
      return { id: `repair:${c.path}`, url: lib.url, sha1: lib.sha1, size: lib.size, dest: lib.url.includes('forge') ? path.join(gameLibsDir, ...c.path.split('/')) : path.join(paths.librariesDir(), ...c.path.split('/')), name: c.path };
    }));
  }

  // 7) Natives 到唯一目录（痛点 #56）
  const nativesDir = path.join(paths.nativesRoot(instanceId), `natives-${startedAt}`);
  extractNatives(resolved, nativesDir);

  // 8) 自动备份存档（痛点 #47）
  if (settings.general.autoBackupBeforeLaunch) {
    try {
      const { createBackup } = await import('./backup');
      const info = await createBackup(instanceId, 'auto', `启动前自动备份`);
      if (info) emitLog(`[mcl] 已自动备份存档：${info.name}`);
    } catch (e) {
      emitLog(`[mcl] 自动备份失败（不影响启动）：${e instanceof Error ? e.message : e}`);
    }
  }

  // 9) 组装参数
  const token = await authService.getValidAccessToken(activeAccountId);
  if (!token) throw new Error('账号令牌无效或已过期，请在「账号」页重新登录。');
  const gameDir = paths.gameDir(instanceId);
  const nativesVar = nativesDir;
  const classpath = [
    path.join(paths.versionsDir(), entry.id, `${entry.id}.jar`),
    ...versionService.collectLibraries(resolved).filter(l => !l.isNative).map(l => {
      const shared = path.join(paths.librariesDir(), ...l.path.split('/'));
      if (fs.existsSync(shared)) return shared;
      return path.join(gameLibsDir, ...l.path.split('/'));
    }),
  ].filter(p => fs.existsSync(p)).join(path.delimiter);

  const mcArgs: string[] = [];
  const effectiveResolution = instance.resolution ?? settings.general.defaultResolution ?? null;
  const features = { is_demo_user: false, has_custom_resolution: !!effectiveResolution };
  const vars: Record<string, string> = {
    auth_player_name: token.name,
    version_name: entry.id,
    game_directory: gameDir,
    assets_root: paths.assetsDir(),
    assets_index_name: String(resolved.assets ?? 'legacy'),
    auth_uuid: token.uuid.replace(/-/g, ''),
    auth_access_token: token.accessToken,
    user_type: token.userType,
    version_type: String(resolved.type ?? 'release'),
    natives_directory: nativesVar,
    launcher_name: 'MCL',
    launcher_version: '0.1.0',
    classpath_separator: path.delimiter,
    classpath,
    library_directory: paths.librariesDir(),
    resolution_width: String(effectiveResolution?.width ?? 1280),
    resolution_height: String(effectiveResolution?.height ?? 720),
  };

  const preset = MEMORY_PRESETS[instance.memoryPreset ?? 'standard'];
  const jvmArgs: string[] = [`-Xms${preset.initial}`, `-Xmx${preset.max}`, ...preset.gc];
  if (settings.launch.utf8Encoding) {
    jvmArgs.push('-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8');
  }
  // Log4j 缓解（痛点生态 #5：1.17 以下自动加）
  const isOldMc = /^1\.([0-9]|1[0-6])\./.test(entry.id) || /^1\.([0-9]|1[0-6])$/.test(entry.id);
  if (settings.launch.log4jFix && isOldMc) {
    jvmArgs.push('-Dlog4j2.formatMsgNoLookups=true');
  }
  // 用户额外参数
  if (instance.jvmArgsExtra) {
    for (const piece of instance.jvmArgsExtra.split(/\s+|\n+/).map(s => s.trim()).filter(Boolean)) {
      jvmArgs.push(piece);
    }
  }
  // 全局附加参数（实例之后，方便统一加代理 / 优化参数）
  if (settings.launch.globalJvmArgs) {
    for (const piece of settings.launch.globalJvmArgs.split(/\s+|\n+/).map(s => s.trim()).filter(Boolean)) {
      jvmArgs.push(piece);
    }
  }
  // 代理（设置 → 网络 → 游戏走代理）
  for (const piece of proxyJvmArgs()) jvmArgs.push(piece);

  // 来自版本 json 的 jvm 参数（过滤掉旧版的 -Xmx，使用我们的预设）
  if (Array.isArray(resolved.arguments?.jvm)) {
    for (const item of resolved.arguments.jvm) {
      if (!evalArgRules(item, features)) continue;
      const tokens = argValueTokens(typeof item === 'object' && item !== null && 'value' in item ? item.value : item, vars);
      for (const t of tokens) {
        if (/^-Xm[xs]/i.test(t)) continue;            // 内存交给预设
        if (t.includes('${')) continue;                // 仍有未解析变量则跳过
        jvmArgs.push(t);
      }
    }
  } else {
    jvmArgs.push('-cp', classpath);
  }
  // natives 库路径兜底（1.12.2 及更早版本 json 没有 arguments.jvm，旧版分支必须显式设置）
  if (!jvmArgs.some(a => a.includes('java.library.path'))) {
    jvmArgs.push(`-Djava.library.path=${nativesVar}`);
  }
  if (!jvmArgs.some(a => a.includes('org.lwjgl.librarypath'))) {
    jvmArgs.push(`-Dorg.lwjgl.librarypath=${nativesVar}`);
  }

  // 游戏参数（新格式）
  if (Array.isArray(resolved.arguments?.game)) {
    for (const item of resolved.arguments.game) {
      if (!evalArgRules(item, features)) continue;
      const tokens = argValueTokens(typeof item === 'object' && item !== null && 'value' in item ? item.value : item, vars);
      mcArgs.push(...tokens);
    }
  } else if (typeof resolved.minecraftArguments === 'string') {
    mcArgs.push(...String(resolved.minecraftArguments).split(/\s+/).map(s => substitute(s, vars)).filter(Boolean));
  }

  const mainClass: string = resolved.mainClass;
  if (!mainClass) throw new Error('版本 json 缺少 mainClass，文件可能已损坏，请在实例设置中重置版本。');

  jvmArgs.push(mainClass, ...mcArgs);

  // 10) 启动！
  emitStatus('launching', '正在启动游戏…');
  emitLog(`[mcl] 启动参数：${java.path} ${jvmArgs.slice(0, 6).join(' ')} …（共 ${jvmArgs.length} 个参数）`);
  const child = spawn(java.path, jvmArgs, {
    cwd: gameDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launchState.instanceId = instanceId;
  launchState.pid = child.pid ?? null;
  trackPid(child.pid ?? 0);

  child.stdout?.on('data', d => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) emitLog(line); });
  child.stderr?.on('data', d => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) emitLog(line); });

  launchState.status = 'running';
  launchEvents.emit('status', { ...launchState });

  const sessionStart = Date.now();
  child.on('close', (code) => {
    if (child.pid) untrackPid(child.pid);
    const playSeconds = Math.floor((Date.now() - sessionStart) / 1000);
    touchPlayed(instanceId, playSeconds);
    safeRmDir(nativesDir);
    emitLog(`[mcl] 游戏进程退出，退出码 ${code}`);
    if (code === 0) {
      emitStatus('exited', `游戏正常退出（游玩时长 ${Math.floor(playSeconds / 60)} 分钟）`);
      launchEvents.emit('exit', { instanceId, code, crashed: false });
      return;
    }
    // 崩溃：自动分析（痛点 #26/#27/#25），只分析本次启动产生的内容
    const diagnosis = analyzeCrash(instanceId, path.join(paths.logsDir(), launchLogName), startedAt);
    launchState.status = 'crashed';
    launchEvents.emit('status', { ...launchState, message: diagnosis.title });
    launchEvents.emit('crash', diagnosis);
  });
  child.on('error', (err) => {
    if (child.pid) untrackPid(child.pid);
    emitStatus('exited', `启动失败：${err.message}`);
    launchEvents.emit('exit', { instanceId, code: -1, crashed: true });
  });
}
