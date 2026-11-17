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
  return {
    ...cfg,
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

export function createInstance(input: {
  name: string; mcVersion: string; loader: LoaderType; loaderVersion?: string | null;
  memoryPreset?: MemoryPreset; javaPath?: string | null;
}): InstanceConfig {
  const id = newId();
  const cfg: InstanceConfig = {
    id,
    name: input.name.trim() || `${input.mcVersion}${input.loader !== 'vanilla' ? '-' + input.loader : ''}`,
    mcVersion: input.mcVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion ?? null,
    javaPath: input.javaPath ?? null,
    memoryPreset: input.memoryPreset ?? 'standard',
    createdAt: Date.now(),
    lastPlayedAt: null,
    playTimeSeconds: 0,
  };
  const game = paths.gameDir(id);
  for (const sub of paths.GAME_SUBDIRS) {
    fs.mkdirSync(path.join(game, sub), { recursive: true });
  }
  writeJson(paths.instanceFile(id), cfg);
  return cfg;
}

export function updateInstance(id: string, patch: Partial<InstanceConfig>): InstanceConfig | null {
  const file = paths.instanceFile(id);
  const current = readJson<InstanceConfig | null>(file, null);
  if (!isInstanceConfig(current) || current.id !== id) return null;
  const merged: InstanceConfig = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
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
  updateInstance(id, { lastPlayedAt: Date.now(), playTimeSeconds: (readJson<InstanceConfig | null>(paths.instanceFile(id), null)?.playTimeSeconds ?? 0) + seconds });
}

/** 所有接受实例 ID 的写操作都必须先过这里：path.join 不会拦住 ../../ 路径穿越 */
function assertInstanceId(id: string): void {
  if (!/^[a-f0-9]{16}$/.test(String(id ?? ''))) throw new Error('实例不存在');
}

export function deleteInstance(id: string, backupDir?: string): { ok: boolean; backupPath?: string } {
  assertInstanceId(id);
  const dir = paths.instanceDir(id);
  if (!fs.existsSync(dir)) return { ok: false };
  if (backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, `instance-${id}-${Date.now()}.zip`);
    // 复用 backup 模块打包（延迟导入避免循环依赖）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { zipFromDir } = require('./zip') as typeof import('./zip');
    fs.writeFileSync(dest, zipFromDir(dir));
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, backupPath: dest };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
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
