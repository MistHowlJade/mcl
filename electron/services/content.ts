/**
 * 内容管理：资源包 / 光影包 / 截图 / 世界
 * - 列出、导入、删除、打开目录
 * - 资源包与光影包开关直接写 options.txt / iris.properties
 * - 世界删除前自动打包到实例备份目录（后悔药）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { getInstance } from './instances';
import { zipDirToFile, zipListFromFile, zipExtractAllFromFile } from './zip';
import { writeJson } from './store';
import { ContentItem, ContentKind, ContentList } from '../shared/types';

/** 世界备份动辄数百 MB：流式写 .part 再改名，进程中断时不会留下能被恢复列表读到的截断 ZIP */
async function writeZipAtomic(filePath: string, dir: string): Promise<void> {
  const partPath = `${filePath}.part`;
  try {
    await zipDirToFile(dir, partPath);
    fs.renameSync(partPath, filePath);
  } catch (e) {
    try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

function walkBytes(dir: string): number {
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

function dirMtime(dir: string): number {
  let max = 0;
  try { max = fs.statSync(dir).mtimeMs; } catch { return Date.now(); }
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { max = Math.max(max, fs.statSync(full).mtimeMs); } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return max;
}

function readOptions(gameDir: string): { lines: string[]; map: Map<string, string> } {
  const file = path.join(gameDir, 'options.txt');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const map = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf(':');
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return { lines, map };
}

function enabledResourcePacks(gameDir: string): Set<string> {
  const { map } = readOptions(gameDir);
  const raw = map.get('resourcePacks') ?? '["vanilla"]';
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(x => String(x)) : []);
  } catch {
    return new Set();
  }
}

function enabledShaderPack(gameDir: string): string | null {
  // OptiFine 即使没开光影也会留下 shaderPack=（空值）；此时不能直接返回 null，
  // 否则同一实例里 Iris 的 config/iris.properties 选择会被当成“未启用”
  for (const file of [path.join(gameDir, 'optionsshaders.txt'), path.join(gameDir, 'config', 'iris.properties')]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (!line.startsWith('shaderPack=')) continue;
        const value = line.slice('shaderPack='.length).trim();
        if (value) return value;
      }
    } catch { /* 文件可能在读取瞬间被游戏重写或删除 */ }
  }
  return null;
}

function listPackDir(dir: string, enabled?: Set<string>): ContentItem[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.name.toLowerCase() !== 'readme.txt')
    .map(e => {
      const full = path.join(dir, e.name);
      let size = 0;
      let mtime = Date.now();
      try {
        const stat = fs.statSync(full);
        size = e.isDirectory() ? walkBytes(full) : stat.size;
        mtime = e.isDirectory() ? dirMtime(full) : stat.mtimeMs;
      } catch { /* ignore */ }
      return {
        name: e.name.replace(/\.zip$/i, ''),
        fileName: e.name,
        path: full,
        sizeBytes: size,
        mtime,
        enabled: enabled ? enabled.has(`file/${e.name}`) || enabled.has(`file/${e.name.replace(/\.zip$/i, '')}`) : undefined,
        previewPath: null,
      } as ContentItem;
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function listContent(instanceId: string): ContentList {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const game = instance.gameDir;
  const packs = enabledResourcePacks(game);
  const shader = enabledShaderPack(game);

  const resourcepacks = listPackDir(path.join(game, 'resourcepacks'), packs);
  const shaderpacks = listPackDir(path.join(game, 'shaderpacks')).map(s => ({ ...s, enabled: shader === s.fileName || shader === s.name }));

  const screenshotsDir = path.join(game, 'screenshots');
  const screenshots: ContentItem[] = [];
  if (fs.existsSync(screenshotsDir)) {
    for (const f of fs.readdirSync(screenshotsDir)) {
      if (!/\.(png|jpe?g)$/i.test(f)) continue;
      const full = path.join(screenshotsDir, f);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        screenshots.push({ name: f.replace(/\.(png|jpe?g)$/i, ''), fileName: f, path: full, sizeBytes: stat.size, mtime: stat.mtimeMs, previewPath: full });
      } catch { /* 文件可能在列目录瞬间被删除 */ }
    }
    screenshots.sort((a, b) => b.mtime - a.mtime);
  }

  const savesDir = path.join(game, 'saves');
  const worlds: ContentItem[] = fs.existsSync(savesDir)
    ? fs.readdirSync(savesDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
      const full = path.join(savesDir, e.name);
      const icon = path.join(full, 'icon.png');
      return {
        name: e.name,
        fileName: e.name,
        path: full,
        sizeBytes: walkBytes(full),
        mtime: dirMtime(full),
        previewPath: fs.existsSync(icon) ? icon : null,
      };
    }).sort((a, b) => b.mtime - a.mtime)
    : [];

  return { resourcepacks, shaderpacks, screenshots, worlds };
}

/* ------------------------------ 开关 ------------------------------ */

/** 资源包/光影文件名来自渲染进程：不能带路径分隔符或换行（会注入 options/iris 配置的其它行） */
function assertPackFileName(fileName: string): void {
  if (typeof fileName !== 'string' || !fileName || /[\\/\r\n]/.test(fileName)) {
    throw new Error('文件名不合法');
  }
}

function writeOptionLine(gameDir: string, key: string, value: string): void {
  const file = path.join(gameDir, 'options.txt');
  const { lines } = readOptions(gameDir);
  const idx = lines.findIndex(l => l.startsWith(`${key}:`));
  if (idx >= 0) lines[idx] = `${key}:${value}`;
  else lines.push(`${key}:${value}`);
  fs.writeFileSync(file, lines.filter((l, i) => l !== '' || i < lines.length - 1).join('\n') + '\n', 'utf8');
}

/** 可视化设置只允许写 MC 原生 options.txt 键，避免注入未知配置或破坏文件格式 */
const EDITABLE_OPTION_KEYS = [
  'renderDistance', 'simulationDistance', 'graphicsMode', 'fancyGraphics', 'smoothLighting', 'ao',
  'clouds', 'particles', 'entityShadows', 'guiScale', 'maxFps', 'gamma', 'volume', 'musicVolume',
  'recordVolume', 'mipmapLevels', 'vsync', 'fullscreen', 'overrideWidth', 'overrideHeight',
] as const;

/** 读取可被界面编辑的游戏设置（只返回白名单内的键） */
export function readGameOptions(instanceId: string): Record<string, string> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const { map } = readOptions(instance.gameDir);
  const out: Record<string, string> = {};
  // 只返回文件里真实存在的键：没写过的项保持游戏默认值，保存时也不会往 options.txt 塞空行
  for (const key of EDITABLE_OPTION_KEYS) {
    const value = map.get(key);
    if (value) out[key] = value;
  }
  return out;
}

/** 保存游戏设置：白名单 + 值校验，防止把 options.txt 写坏 */
export function saveGameOptions(instanceId: string, patch: Record<string, string>): Record<string, string> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (!patch || typeof patch !== 'object') throw new Error('设置内容不合法');
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE_OPTION_KEYS as readonly string[]).includes(key)) continue;
    if (typeof value !== 'string' || value.length > 64 || /[\r\n]/.test(value)) {
      throw new Error(`「${key}」的值不合法`);
    }
    writeOptionLine(instance.gameDir, key, value);
  }
  return readGameOptions(instanceId);
}

export function toggleResourcePack(instanceId: string, fileName: string): boolean {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  assertPackFileName(fileName);
  const enabled = enabledResourcePacks(instance.gameDir);
  const key = `file/${fileName}`;
  const alt = `file/${fileName.replace(/\.zip$/i, '')}`;
  let now: boolean;
  if (enabled.has(key) || enabled.has(alt)) {
    enabled.delete(key); enabled.delete(alt); now = false;
  } else {
    enabled.add(key); now = true;
  }
  writeOptionLine(instance.gameDir, 'resourcePacks', JSON.stringify([...enabled]));
  return now;
}

export function toggleShaderPack(instanceId: string, fileName: string): boolean {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  assertPackFileName(fileName);
  const game = instance.gameDir;
  const current = enabledShaderPack(game);
  const next = current === fileName || current === fileName.replace(/\.zip$/i, '') ? '' : fileName;
  // Iris/OptiFine 两套配置都写，切哪个都能生效
  const irisDir = path.join(game, 'config');
  fs.mkdirSync(irisDir, { recursive: true });
  const iris = path.join(irisDir, 'iris.properties');
  const irisLines = fs.existsSync(iris) ? fs.readFileSync(iris, 'utf8').split(/\r?\n/) : [];
  const irisIdx = irisLines.findIndex(l => l.startsWith('shaderPack='));
  if (irisIdx >= 0) irisLines[irisIdx] = `shaderPack=${next}`; else irisLines.push(`shaderPack=${next}`);
  fs.writeFileSync(iris, irisLines.filter(Boolean).join('\n') + '\n', 'utf8');
  const of = path.join(game, 'optionsshaders.txt');
  const ofLines = fs.existsSync(of) ? fs.readFileSync(of, 'utf8').split(/\r?\n/) : [];
  const ofIdx = ofLines.findIndex(l => l.startsWith('shaderPack='));
  if (ofIdx >= 0) ofLines[ofIdx] = `shaderPack=${next}`; else ofLines.push(`shaderPack=${next}`);
  fs.writeFileSync(of, ofLines.filter(Boolean).join('\n') + '\n', 'utf8');
  return next !== '';
}

/* ------------------------------ 导入 / 删除 ------------------------------ */

function safeName(name: string): string {
  return path.basename(name).replace(/[<>:"/\\|?*]/g, '_') || `item-${Date.now()}`;
}

/** 世界名来自渲染进程/备份元数据：.. 会让 path.join 指到 saves 之外 */
function worldDirOf(gameDir: string, worldName: string): string {
  const base = path.basename(String(worldName ?? ''));
  if (!base || base === '.' || base === '..') throw new Error('世界名称不合法');
  return path.join(gameDir, 'saves', base);
}

function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let target = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base} (${i++})${ext}`);
  return target;
}

function uniqueDir(dir: string, name: string): string {
  let target = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${name} (${i++})`);
  return target;
}

/** 导入世界 ZIP：自动识别/剥离世界根目录，校验 level.dat，返回实际世界名 */
export async function importWorldZip(instanceId: string, zipPath: string): Promise<{ worldName: string; path: string; files: number }> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  let entries;
  try { entries = await zipListFromFile(zipPath); } catch { throw new Error('世界 ZIP 已损坏或不是有效的 ZIP 文件'); }
  const normalized = entries.filter(e => !e.name.endsWith('/')).map(e => e.name.replace(/\\/g, '/'));
  if (normalized.length === 0) throw new Error('世界 ZIP 是空的');
  // 找到 level.dat，把它所在的目录作为世界根（兼容 zip 里再套一层文件夹）
  const levelEntry = normalized.find(n => n === 'level.dat')
    ?? normalized.find(n => n.endsWith('/level.dat') && n.split('/').length === 2)
    ?? normalized.find(n => n.endsWith('/level.dat'));
  if (!levelEntry) throw new Error('这不是一个有效的世界存档（ZIP 里找不到 level.dat）');
  const prefix = levelEntry.includes('/') ? levelEntry.slice(0, levelEntry.lastIndexOf('/') + 1) : '';
  const suggested = prefix
    ? prefix.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? '导入的世界'
    : path.basename(zipPath, path.extname(zipPath));
  const savesDir = path.join(instance.gameDir, 'saves');
  fs.mkdirSync(savesDir, { recursive: true });
  const worldPath = uniqueDir(savesDir, safeName(suggested));
  fs.mkdirSync(worldPath, { recursive: true });
  try {
    const written = await zipExtractAllFromFile(zipPath, worldPath, prefix);
    if (!written.some(p => path.basename(p) === 'level.dat')) throw new Error('解压后没有找到 level.dat');
    return { worldName: path.basename(worldPath), path: worldPath, files: written.length };
  } catch (e) {
    fs.rmSync(worldPath, { recursive: true, force: true });
    throw e;
  }
}

/** 把世界导出为 ZIP（用于分享或手动备份） */
export async function exportWorldZip(instanceId: string, worldName: string, destPath: string): Promise<{ filePath: string; sizeBytes: number }> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const worldDir = worldDirOf(instance.gameDir, worldName);
  if (!fs.existsSync(worldDir) || !fs.statSync(worldDir).isDirectory()) throw new Error('世界不存在');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // 覆盖已有导出文件时先写 .part：磁盘满/中途失败不会把原来那份好文件也毁掉
  await writeZipAtomic(destPath, worldDir);
  return { filePath: destPath, sizeBytes: fs.statSync(destPath).size };
}

export function importContent(instanceId: string, kind: ContentKind, sourcePaths: string[]): { imported: number; skipped: string[] } {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (!['resourcepacks', 'shaderpacks', 'screenshots', 'worlds'].includes(kind)) throw new Error('未知的内容类型');
  if (!Array.isArray(sourcePaths)) throw new Error('没有选择要导入的文件');
  const map: Record<ContentKind, string> = {
    resourcepacks: path.join(instance.gameDir, 'resourcepacks'),
    shaderpacks: path.join(instance.gameDir, 'shaderpacks'),
    screenshots: path.join(instance.gameDir, 'screenshots'),
    worlds: path.join(instance.gameDir, 'saves'),
  };
  const destDir = map[kind];
  fs.mkdirSync(destDir, { recursive: true });
  let imported = 0;
  const skipped: string[] = [];
  for (const src of sourcePaths) {
    try {
      if (!fs.existsSync(src)) { skipped.push(src); continue; }
      const stat = fs.statSync(src);
      if (kind === 'worlds') {
        if (!stat.isDirectory()) {
          if (/\.zip$/i.test(src)) { importWorldZip(instanceId, src); imported++; }
          else skipped.push(src);
          continue;
        }
        // 世界文件夹：必须含 level.dat，避免把普通文件夹塞进 saves
        if (!fs.existsSync(path.join(src, 'level.dat'))) { skipped.push(src); continue; }
        const worldDest = uniqueDir(destDir, safeName(path.basename(src)));
        fs.cpSync(src, worldDest, { recursive: true });
        imported++;
        continue;
      }
      if (stat.isDirectory()) {
        // 资源包/光影包目录：整体复制
        const dest = uniqueTarget(destDir, safeName(path.basename(src)));
        fs.cpSync(src, dest, { recursive: true });
      } else {
        const dest = uniqueTarget(destDir, safeName(path.basename(src)));
        fs.copyFileSync(src, dest);
      }
      imported++;
    } catch {
      skipped.push(src);
    }
  }
  return { imported, skipped };
}

export async function deleteContent(instanceId: string, kind: ContentKind, fileName: string): Promise<{ deleted: boolean; backupPath?: string }> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (!['resourcepacks', 'shaderpacks', 'screenshots', 'worlds'].includes(kind)) throw new Error('未知的内容类型');
  const map: Record<ContentKind, string> = {
    resourcepacks: path.join(instance.gameDir, 'resourcepacks'),
    shaderpacks: path.join(instance.gameDir, 'shaderpacks'),
    screenshots: path.join(instance.gameDir, 'screenshots'),
    worlds: path.join(instance.gameDir, 'saves'),
  };
  const target = path.join(map[kind], path.basename(fileName));
  if (!target.startsWith(path.resolve(map[kind]) + path.sep)) throw new Error('非法路径');
  if (!fs.existsSync(target)) return { deleted: false };
  let backupPath: string | undefined;
  if (kind === 'worlds') {
    const dir = paths.instanceBackupsDir(instanceId);
    fs.mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    backupPath = path.join(dir, `world-${ts}.zip`);
    await writeZipAtomic(backupPath, target);
    writeJson(backupPath.replace(/\.zip$/, '.json'), { name: `删除世界前自动备份：${path.basename(fileName)}`, createdAt: ts, worldNames: [path.basename(fileName)], kind: 'world' });
  }
  fs.rmSync(target, { recursive: true, force: true });
  return { deleted: true, backupPath };
}

export async function backupWorld(instanceId: string, worldName: string, displayName?: string): Promise<string> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const worldDir = worldDirOf(instance.gameDir, worldName);
  if (!fs.existsSync(worldDir) || !fs.statSync(worldDir).isDirectory()) throw new Error('世界不存在');
  const dir = paths.instanceBackupsDir(instanceId);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const filePath = path.join(dir, `world-${ts}.zip`);
  await writeZipAtomic(filePath, worldDir);
  writeJson(filePath.replace(/\.zip$/, '.json'), { name: displayName ?? `世界备份：${path.basename(worldName)}`, createdAt: ts, worldNames: [path.basename(worldName)], kind: 'world' });
  return filePath;
}