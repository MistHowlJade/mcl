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

export function listInstanceFiles(): InstanceConfig[] {
  const dir = paths.instancesDir();
  if (!fs.existsSync(dir)) return [];
  const out: InstanceConfig[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = paths.instanceFile(entry.name);
    const cfg = readJson<InstanceConfig | null>(file, null);
    if (cfg) out.push(cfg);
  }
  return out.sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt));
}

function countDirEntries(dir: string): number {
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

export function toInfo(cfg: InstanceConfig): InstanceInfo {
  const game = paths.gameDir(cfg.id);
  return {
    ...cfg,
    gameDir: game,
    modsCount: countDirEntries(path.join(game, 'mods')),
    savesCount: countDirEntries(path.join(game, 'saves')),
  };
}

export function listInstances(): InstanceInfo[] {
  return listInstanceFiles().map(toInfo);
}

export function getInstance(id: string): InstanceInfo | null {
  const cfg = readJson<InstanceConfig | null>(paths.instanceFile(id), null);
  return cfg ? toInfo(cfg) : null;
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
  if (!current) return null;
  const merged: InstanceConfig = { ...current, ...patch, id: current.id, createdAt: current.createdAt };
  writeJson(file, merged);
  return merged;
}

export function touchPlayed(id: string, seconds: number): void {
  updateInstance(id, { lastPlayedAt: Date.now(), playTimeSeconds: (readJson<InstanceConfig | null>(paths.instanceFile(id), null)?.playTimeSeconds ?? 0) + seconds });
}

export function deleteInstance(id: string, backupDir?: string): { ok: boolean; backupPath?: string } {
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
