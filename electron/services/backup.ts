/**
 * 存档备份与恢复（痛点 #29/#47/#48）
 * - 手动 / 启动前自动 / 恢复前自动 三类备份
 * - 备份内容：saves（整个世界）+ options.txt + servers.dat + keybinds
 * - 保留数量可配置，自动清理最旧的
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { BackupInfo } from '../shared/types';
import { zipExtractAll, zipList } from './zip';
import { getSettings } from './settings';
import { getInstance } from './instances';

const BACKUP_SUBSET = ['saves', 'options.txt', 'servers.dat', 'keybinds.txt'];

function collectIncludedFiles(gameDir: string): string[] {
  const includes: string[] = [];
  for (const sub of BACKUP_SUBSET) {
    const full = path.join(gameDir, sub);
    if (fs.existsSync(full)) includes.push(sub);
  }
  return includes;
}

/** 实例 ID 来自渲染进程，必须先校验，避免 ../ 把备份目录指到数据目录之外 */
const isInstanceId = (id: string): boolean => /^[a-f0-9]{16}$/.test(String(id ?? ''));

/** 备份元数据可能被手工改坏：JSON.parse('null') 不抛错但会让 meta.name 直接崩，必须校验是对象 */
function readBackupMeta(file: string): Partial<BackupInfo> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<BackupInfo> : {};
  } catch {
    return {};
  }
}

export function listBackups(instanceId: string): BackupInfo[] {
  if (!isInstanceId(instanceId)) return [];
  const dir = paths.instanceBackupsDir(instanceId);
  if (!fs.existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.zip')) continue;
    const file = path.join(dir, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; } // 可能刚被自动清理
    // 从文件名还原元数据：<kind>-<ts>.zip；meta.json 可能被手工改坏，逐字段校验
    const m = name.match(/^(auto|manual|pre-restore|world)-(\d+)/);
    const metaPath = file.replace(/\.zip$/, '.json');
    const meta = readBackupMeta(metaPath);
    const metaName = typeof meta.name === 'string' && meta.name.trim() ? meta.name : name;
    const worldNames = Array.isArray(meta.worldNames)
      ? meta.worldNames.filter((w): w is string => typeof w === 'string')
      : [];
    const createdAt = typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : stat.mtimeMs;
    out.push({
      id: name.replace(/\.zip$/, ''),
      instanceId,
      name: metaName,
      filePath: file,
      sizeBytes: stat.size,
      createdAt,
      kind: (m?.[1] as BackupInfo['kind']) ?? 'manual',
      worldNames,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createBackup(instanceId: string, kind: BackupInfo['kind'], displayName?: string): Promise<BackupInfo | null> {
  const instance = getInstance(instanceId);
  if (!instance) return null;
  const gameDir = instance.gameDir;
  const included = collectIncludedFiles(gameDir);
  if (included.length === 0) return null; // 没有存档可备份
  const worldNames = included.includes('saves')
    ? fs.readdirSync(path.join(gameDir, 'saves')).filter(d => {
      try { return fs.statSync(path.join(gameDir, 'saves', d)).isDirectory(); } catch { return false; }
    })
    : [];

  // 构造打包清单：saves/ 整个目录 + 根目录的配置文件
  const { zipWrite } = await import('./zip');
  const files: Array<{ name: string; data: Buffer; mtime: Date }> = [];
  const walkAdd = (absDir: string, relPrefix: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) walkAdd(abs, rel);
      else { try { files.push({ name: rel, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime }); } catch { /* skip */ } }
    }
  };
  for (const inc of included) {
    const abs = path.join(gameDir, inc);
    try {
      if (fs.statSync(abs).isDirectory()) walkAdd(abs, inc);
      else files.push({ name: inc, data: fs.readFileSync(abs), mtime: fs.statSync(abs).mtime });
    } catch { /* 文件可能在备份瞬间被删除 */ }
  }
  if (files.length === 0) return null; // 空目录（如只有一个空 saves/）不产生空备份

  const ts = Date.now();
  const id = `${kind}-${ts}`;
  const dir = paths.instanceBackupsDir(instanceId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.zip`);
  fs.writeFileSync(filePath, zipWrite(files));
  const info: BackupInfo = {
    id,
    instanceId,
    name: displayName ?? (kind === 'auto' ? '启动前自动备份' : kind === 'pre-restore' ? '恢复前自动备份' : '手动备份'),
    filePath,
    sizeBytes: fs.statSync(filePath).size,
    createdAt: ts,
    kind,
    worldNames,
  };
  fs.writeFileSync(filePath.replace(/\.zip$/, '.json'), JSON.stringify({ name: info.name, createdAt: ts, worldNames, kind }, null, 2), 'utf8');
  pruneOldBackups(instanceId);
  return info;
}

export function pruneOldBackups(instanceId: string): void {
  const raw = getSettings().general.backupKeep;
  // 配置损坏成 NaN/负数时兜底：slice(NaN) 会把自动备份全删光
  const keep = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.floor(raw))) : 10;
  const autos = listBackups(instanceId).filter(b => b.kind === 'auto');
  for (const old of autos.slice(keep)) {
    fs.rmSync(old.filePath, { force: true });
    fs.rmSync(old.filePath.replace(/\.zip$/, '.json'), { force: true });
  }
}

export function deleteBackup(id: string, instanceId?: string): void {
  // id 形如 auto-1234；优先按实例定位，避免同毫秒备份 ID 误删其它实例的文件
  const safeId = path.basename(String(id ?? ''));
  if (!safeId) return;
  if (instanceId) {
    if (!/^[a-f0-9]{16}$/.test(instanceId)) throw new Error('实例 ID 不合法');
    const dir = paths.instanceBackupsDir(instanceId);
    fs.rmSync(path.join(dir, `${safeId}.zip`), { force: true });
    fs.rmSync(path.join(dir, `${safeId}.json`), { force: true });
    return;
  }
  // 兼容旧调用：没有实例信息时在所有实例备份目录下查找
  const root = paths.backupsDir();
  if (!fs.existsSync(root)) return;
  for (const sub of fs.readdirSync(root)) {
    const zip = path.join(root, sub, `${safeId}.zip`);
    const meta = path.join(root, sub, `${safeId}.json`);
    fs.rmSync(zip, { force: true });
    fs.rmSync(meta, { force: true });
  }
}

export async function restoreBackup(backupId: string, instanceId: string): Promise<{ restoredFiles: number }> {
  if (!isInstanceId(instanceId)) throw new Error('实例不存在');
  const dir = paths.instanceBackupsDir(instanceId);
  const safeId = path.basename(String(backupId ?? ''));
  const zipPath = path.join(dir, `${safeId}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error('备份文件不存在');
  // 恢复前先自动备份一次当前状态（痛点 #29：后悔药）
  await createBackup(instanceId, 'pre-restore', '恢复前自动备份');
  const gameDir = paths.gameDir(instanceId);
  const buf = fs.readFileSync(zipPath);

  // 世界单独备份（内容管理的「备份世界」/删除前自动备份）是“世界目录内部”打包，
  // 需要还原到 saves/<世界名>/；完整存档备份则直接还原到游戏根目录。
  let targetDir = gameDir;
  const metaPath = zipPath.replace(/\.zip$/, '.json');
  const meta = readBackupMeta(metaPath);
  const entries = zipList(buf).map(e => e.name.replace(/\\/g, '/'));
  const alreadyPrefixed = entries.some(n => n === 'saves' || n.startsWith('saves/'));
  // 元数据丢失时不把世界包倒进游戏根目录：没有 saves/ 前缀且带 level.dat 的就是单个世界
  const looksLikeWorld = meta.kind === 'world' || (!meta.kind && !alreadyPrefixed && entries.includes('level.dat'));
  if (looksLikeWorld && !alreadyPrefixed) {
    const recordedName = Array.isArray(meta.worldNames) && typeof meta.worldNames[0] === 'string' ? meta.worldNames[0] : '';
    let worldName = path.basename(recordedName || `restored-${safeId}`);
    // basename('..') 仍是 '..'：会还原到游戏根目录而不是 saves/<世界名>/
    if (!worldName || worldName === '.' || worldName === '..') worldName = `restored-${safeId}`;
    targetDir = path.join(gameDir, 'saves', worldName);
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 只允许还原到白名单子目录（zipExtractAll 内部还会做目录穿越防护）
  const written = zipExtractAll(buf, targetDir, undefined);
  return { restoredFiles: written.length };
}
