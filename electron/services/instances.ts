/**
 * 实例管理（版本隔离痛点 #43/#44/#48）
 * - 每个实例独立的 game/ 目录（saves/mods/config/...）
 * - 库与资源全实例硬共享（不复制文件，只引用路径），磁盘零重复
 * - 实例元数据 instance.json + 全局索引 instances.json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as paths from './paths';
import { InstanceConfig, InstanceInfo, LoaderType, MemoryPreset } from '../shared/types';
import { readJson, writeJson } from './store';
import { zipDirToFile } from './zip';

const newId = () => crypto.randomBytes(8).toString('hex');

/** instance.json 可能被手工改坏/半写入：字段不完整时跳过，别让实例列表或启动流程崩掉 */
function isInstanceConfig(value: unknown): value is InstanceConfig {
  if (!value || typeof value !== 'object') return false;
  const cfg = value as Record<string, unknown>;
  return typeof cfg.id === 'string' && /^[a-f0-9]{16}$/.test(cfg.id)
    && typeof cfg.name === 'string'
    && typeof cfg.mcVersion === 'string'
    && typeof cfg.createdAt === 'number'
    && ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(String(cfg.loader));
}

/** 加载器版本只允许普通版本号字符：不能以 - 开头，避免被拼进 URL/安装器参数 */
const isLoaderVersion = (v: unknown): v is string => typeof v === 'string'
  && /^[0-9A-Za-z][0-9A-Za-z._+\-]{0,63}$/.test(v);

export function listInstanceFiles(): InstanceConfig[] {
  const dir = paths.instancesDir();
  if (!fs.existsSync(dir)) return [];
  const out: InstanceConfig[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = paths.instanceFile(entry.name);
    const cfg = readJson<InstanceConfig | null>(file, null);
    // 目录名与配置里的 id 必须一致，否则会得到一个指向错误 game/ 目录的“幽灵实例”
    if (isInstanceConfig(cfg) && cfg.id === entry.name) out.push(cfg);
  }
  return out.sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt));
}

function countDirEntries(dir: string): number {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

export function toInfo(cfg: InstanceConfig): InstanceInfo {
  const game = paths.gameDir(cfg.id);
  // memoryPreset 可能被手工改坏：内存预设查表是直接用下标，非法值会让启动/实例页直接崩
  const memoryPreset: MemoryPreset = cfg.memoryPreset === 'low' || cfg.memoryPreset === 'heavy' ? cfg.memoryPreset : 'standard';
  // loaderVersion 可能被手工改坏：非法值会被拼进下载 URL/安装器参数，读取时统一丢弃
  const loaderVersion = typeof cfg.loaderVersion === 'string' && isLoaderVersion(cfg.loaderVersion.trim())
    ? cfg.loaderVersion.trim()
    : null;
  return {
    ...cfg,
    loaderVersion,
    memoryPreset,
    gameDir: game,
    modsCount: countDirEntries(path.join(game, 'mods')),
    savesCount: countDirEntries(path.join(game, 'saves')),
  };
}

export function listInstances(): InstanceInfo[] {
  return listInstanceFiles().map(toInfo);
}

export function getInstance(id: string): InstanceInfo | null {
  if (!/^[a-f0-9]{16}$/.test(String(id ?? ''))) return null;
  const cfg = readJson<InstanceConfig | null>(paths.instanceFile(id), null);
  return isInstanceConfig(cfg) && cfg.id === id ? toInfo(cfg) : null;
}

const LOADER_TYPES: LoaderType[] = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
const MEMORY_PRESETS: MemoryPreset[] = ['low', 'standard', 'heavy'];
const isLoaderType = (v: unknown): v is LoaderType => LOADER_TYPES.includes(v as LoaderType);
const isMemoryPreset = (v: unknown): v is MemoryPreset => MEMORY_PRESETS.includes(v as MemoryPreset);
/** 堆内存（MB）：128MB 以下会被 JVM 拒绝，64GB 以上基本都是误填 */
const isHeapMB = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 256 && (v as number) <= 65536;
/** 版本号会进入 URL/目录名：拒绝路径分隔符、. / ..、以及只有点的名字 */
const isMcVersion = (v: unknown): v is string => typeof v === 'string'
  && v.length > 0 && v.length <= 128
  && /^[0-9A-Za-z_\-[\]]+(\.[0-9A-Za-z_\-[\]]+)*$/.test(v);

/** 标签只用于界面筛选：限制数量与长度，去掉空白/换行，避免写坏 instance.json */
function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().replace(/[\r\n]/g, ' ').slice(0, 20);
    if (tag) seen.add(tag);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

export function createInstance(input: {
  name: string; mcVersion: string; loader: LoaderType; loaderVersion?: string | null;
  memoryPreset?: MemoryPreset; javaPath?: string | null;
  heapInitialMB?: number | null; heapMaxMB?: number | null;
  tags?: string[]; favorite?: boolean;
}): InstanceConfig {
  // IPC 参数只是 TS 类型：运行时也要挡住空值/非法加载器，否则会写出启动不了的实例
  if (!input || typeof input !== 'object') throw new Error('创建实例的参数不完整');
  if (!isMcVersion(input.mcVersion)) throw new Error('Minecraft 版本号格式不正确');
  if (!isLoaderType(input.loader)) throw new Error('不支持的模组加载器');
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const loaderVersion = typeof input.loaderVersion === 'string' ? input.loaderVersion.trim() : '';
  if (loaderVersion && !isLoaderVersion(loaderVersion)) {
    throw new Error('加载器版本号格式不正确（只能包含字母、数字、点、下划线、加号和短横线）');
  }
  const id = newId();
  const cfg: InstanceConfig = {
    id,
    name: name || `${input.mcVersion}${input.loader !== 'vanilla' ? '-' + input.loader : ''}`,
    mcVersion: input.mcVersion,
    loader: input.loader,
    loaderVersion: loaderVersion || null,
    javaPath: typeof input.javaPath === 'string' && input.javaPath.trim() ? input.javaPath.trim() : null,
    memoryPreset: isMemoryPreset(input.memoryPreset) ? input.memoryPreset : 'standard',
    ...(isHeapMB(input.heapInitialMB) && isHeapMB(input.heapMaxMB) && input.heapInitialMB <= input.heapMaxMB
      ? { heapInitialMB: input.heapInitialMB, heapMaxMB: input.heapMaxMB }
      : {}),
    createdAt: Date.now(),
    lastPlayedAt: null,
    playTimeSeconds: 0,
    tags: normalizeTags(input.tags) ?? [],
    favorite: input.favorite === true,
  };
  const game = paths.gameDir(id);
  for (const sub of paths.GAME_SUBDIRS) {
    fs.mkdirSync(path.join(game, sub), { recursive: true });
  }
  writeJson(paths.instanceFile(id), cfg);
  return cfg;
}

export function updateInstance(id: string, patch: Partial<InstanceConfig>): InstanceConfig | null {
  if (!/^[a-f0-9]{16}$/.test(String(id ?? ''))) return null;
  const file = paths.instanceFile(id);
  const current = readJson<InstanceConfig | null>(file, null);
  if (!isInstanceConfig(current) || current.id !== id) return null;
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<InstanceConfig>;
  const merged: InstanceConfig = { ...current, id: current.id, createdAt: current.createdAt };
  // 逐字段校验后再落盘：非法值会让实例从列表里消失（isInstanceConfig 要求 loader 合法）
  if (typeof p.name === 'string' && p.name.trim()) merged.name = p.name.trim().slice(0, 80);
  if (isMcVersion(p.mcVersion)) merged.mcVersion = p.mcVersion;
  if (isLoaderType(p.loader)) merged.loader = p.loader;
  if ('loaderVersion' in p) {
    const raw = typeof p.loaderVersion === 'string' ? p.loaderVersion.trim() : '';
    if (raw && !isLoaderVersion(raw)) {
      throw new Error('加载器版本号格式不正确（只能包含字母、数字、点、下划线、加号和短横线）');
    }
    merged.loaderVersion = raw || null;
  }
  if ('javaPath' in p) merged.javaPath = typeof p.javaPath === 'string' && p.javaPath.trim() ? p.javaPath.trim() : null;
  if ('memoryPreset' in p) merged.memoryPreset = isMemoryPreset(p.memoryPreset) ? p.memoryPreset : 'standard';
  // PCL CE 式：初始堆/最大堆独立设置，必须同时填写且 initial <= max
  if ('heapInitialMB' in p || 'heapMaxMB' in p) {
    const hi = p.heapInitialMB;
    const hm = p.heapMaxMB;
    if (hi == null && hm == null) {
      merged.heapInitialMB = null;
      merged.heapMaxMB = null;
    } else if (!isHeapMB(hi) || !isHeapMB(hm)) {
      throw new Error('初始堆与最大堆需同时填写，且为 256～65536 MB 的整数');
    } else if (hi > hm) {
      throw new Error('初始堆不能大于最大堆');
    } else {
      merged.heapInitialMB = hi;
      merged.heapMaxMB = hm;
    }
  }
  if (typeof p.jvmArgsExtra === 'string') merged.jvmArgsExtra = p.jvmArgsExtra;
  if (typeof p.noModUpdate === 'boolean') merged.noModUpdate = p.noModUpdate;
  if ('tags' in p) merged.tags = normalizeTags(p.tags) ?? [];
  if (typeof p.favorite === 'boolean') merged.favorite = p.favorite;
  if (p.resolution === null || (p.resolution && Number.isInteger(p.resolution.width) && Number.isInteger(p.resolution.height)
    && p.resolution.width > 0 && p.resolution.height > 0)) {
    merged.resolution = p.resolution;
  }
  if ('lastPlayedAt' in p) merged.lastPlayedAt = typeof p.lastPlayedAt === 'number' && Number.isFinite(p.lastPlayedAt) ? p.lastPlayedAt : null;
  if (typeof p.playTimeSeconds === 'number' && Number.isFinite(p.playTimeSeconds) && p.playTimeSeconds >= 0) {
    merged.playTimeSeconds = p.playTimeSeconds;
  }
  writeJson(file, merged);
  return merged;
}

/** 复制实例（模组、存档、配置全部保留），返回新实例 */
export function duplicateInstance(id: string): InstanceConfig {
  const source = getInstance(id);
  if (!source) throw new Error('实例不存在');
  const copyId = newId();
  const srcDir = paths.instanceDir(id);
  const destDir = paths.instanceDir(copyId);
  if (!fs.existsSync(srcDir)) throw new Error('实例目录不存在');
  const cfg: InstanceConfig = {
    ...source,
    id: copyId,
    name: `${source.name} 副本`,
    createdAt: Date.now(),
    lastPlayedAt: null,
    playTimeSeconds: 0,
  };
  try {
    fs.cpSync(srcDir, destDir, { recursive: true });
    writeJson(paths.instanceFile(copyId), cfg);
  } catch (e) {
    // 复制到一半失败（磁盘满/文件被占用）时清理残留：
    // 否则残留目录里还是原实例的 instance.json，列表里可能出现一个指向原实例的“幽灵实例”
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原错误 */ }
    throw e;
  }
  return cfg;
}

export function touchPlayed(id: string, seconds: number): void {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  updateInstance(id, { lastPlayedAt: Date.now(), playTimeSeconds: (readJson<InstanceConfig | null>(paths.instanceFile(id), null)?.playTimeSeconds ?? 0) + safe });
  if (safe > 0) recordPlaySession(safe);
}

/* ---------- 游玩统计 ---------- */
interface PlayLog {
  /** YYYY-MM-DD → 当天游玩秒数（本地时区） */
  days: Record<string, number>;
  sessions: number;
}

function readPlayLog(): PlayLog {
  const raw = readJson<unknown>(paths.playLogFile(), {});
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const days: Record<string, number> = {};
  const rawDays = obj.days && typeof obj.days === 'object' && !Array.isArray(obj.days) ? obj.days as Record<string, unknown> : {};
  for (const [date, seconds] of Object.entries(rawDays)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      days[date] = seconds;
    }
  }
  const sessions = typeof obj.sessions === 'number' && Number.isFinite(obj.sessions) && obj.sessions >= 0 ? Math.floor(obj.sessions) : 0;
  return { days, sessions };
}

/** 每次游戏正常结束由 touchPlayed 调用：同一天的会话累加，不保存具体时间点，保护隐私 */
function recordPlaySession(seconds: number): void {
  const log = readPlayLog();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  log.days[date] = (log.days[date] ?? 0) + seconds;
  log.sessions += 1;
  // 只保留最近 180 天，避免文件无限增长
  const dates = Object.keys(log.days).sort();
  for (const old of dates.slice(0, Math.max(0, dates.length - 180))) delete log.days[old];
  writeJson(paths.playLogFile(), log);
}

/** 首页/统计面板：最近 7 天趋势 + 按实例累计（实例本身已有 playTimeSeconds） */
export function getPlayStats(): import('../shared/types').PlayStats {
  const log = readPlayLog();
  const today = new Date();
  const daily: Array<{ date: string; seconds: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    daily.push({ date, seconds: log.days[date] ?? 0 });
  }
  const totalSeconds = Object.values(log.days).reduce((a, b) => a + b, 0);
  const perInstance = listInstanceFiles()
    .map(c => ({ instanceId: c.id, name: c.name, seconds: c.playTimeSeconds ?? 0 }))
    .filter(x => x.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  return { daily, totalSeconds, sessions: log.sessions, perInstance };
}

/** 所有接受实例 ID 的写操作都必须先过这里：path.join 不会拦住 ../../ 路径穿越 */
function assertInstanceId(id: string): void {
  if (!/^[a-f0-9]{16}$/.test(String(id ?? ''))) throw new Error('实例不存在');
}

/** 删除前备份只保留用户数据；Forge 装进 game/libraries 的几百 MB 库不该再打包一遍 */
function isUserDataPath(rel: string): boolean {
  const top = rel.split('/')[0];
  return ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots'].includes(top)
    || ['options.txt', 'servers.dat', 'keybinds.txt'].includes(top);
}

export function deleteInstance(id: string, backupDir?: string): { ok: boolean; backupPath?: string } {
  assertInstanceId(id);
  const dir = paths.instanceDir(id);
  if (!fs.existsSync(dir)) return { ok: false };
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `instance-${id}-${Date.now()}.zip`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { zipFromDir } = require('./zip') as typeof import('./zip');
    fs.writeFileSync(dest, zipFromDir(dir, isUserDataPath));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, backupPath: dest };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * UI 删除实例走这条：流式打包 + ZIP64。
 * 原来的 zipFromDir 先把所有文件读进一个 Buffer，2GB+ 整合包会让主进程卡死，
 * 超过 4GB 则直接失败（#18）。这里按 1MB 分块写出，内存占用与包体无关。
 */
export async function deleteInstanceWithBackup(id: string, backupDir: string): Promise<{ ok: boolean; backupPath?: string }> {
  assertInstanceId(id);
  const dir = paths.instanceDir(id);
  if (!fs.existsSync(dir)) return { ok: false };
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `instance-${id}-${Date.now()}.zip`);
  const part = `${dest}.part`;
  try {
    await zipDirToFile(dir, part, isUserDataPath);
    fs.renameSync(part, dest);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, backupPath: dest };
}

/** 实例磁盘占用（含共享库不计重复） */
export function instanceDiskBytes(id: string): number {
  assertInstanceId(id);
  const dir = paths.gameDir(id);
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return total;
}

/** 共享资源目录占用 */
export function sharedDiskBytes(): number {
  const shared = paths.sharedDir();
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(shared);
  return total;
}
