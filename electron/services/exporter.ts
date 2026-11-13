/**
 * 实例导出：
 * - mmc：MultiMC / Prism 可导入的实例包（mmc-pack.json + instance.cfg + .minecraft/）
 * - mrpack：Modrinth 整合包格式（modrinth.index.json + overrides/）
 * - zip：MCL 完整实例快照（含实例元数据与游戏目录）
 *
 * 导出只读取实例目录，不修改原实例；库与版本文件不导出，目标启动器会按需下载。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { getInstance } from './instances';
import { zipWrite, ZipEntryInput } from './zip';
import { fetchJson, fetchWithTimeout } from './net';
import { ExportFormat, ExportResult, InstanceInfo, LoaderType } from '../shared/types';

interface WalkEntry { rel: string; data: Buffer; mtime: Date }

const GAME_INCLUDE_DIRS = [
  'mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'saves',
  'schematics', 'xaero', 'journeymap', 'local', 'datapacks',
];
const GAME_INCLUDE_FILES = [
  'options.txt', 'servers.dat', 'keybinds.txt', 'realms_persistence.json', 'optionsof.txt', 'optionsshaders.txt',
];
const GAME_EXCLUDE = /(^|[\\/])(\.part|\.seg\d*|\.tmp|logs?|crash-reports?)([\\/]|$)/i;

function walk(root: string, relPrefix: string, entries: WalkEntry[]): void {
  let list: fs.Dirent[] = [];
  try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (GAME_EXCLUDE.test(rel)) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) { walk(full, rel, entries); continue; }
    try {
      entries.push({ rel, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime });
    } catch { /* 单个文件读失败不阻塞导出 */ }
  }
}

function collectGameFiles(gameDir: string): WalkEntry[] {
  const entries: WalkEntry[] = [];
  for (const dir of GAME_INCLUDE_DIRS) {
    const full = path.join(gameDir, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full, dir, entries);
  }
  for (const file of GAME_INCLUDE_FILES) {
    const full = path.join(gameDir, file);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      try { entries.push({ rel: file, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime }); } catch { /* ignore */ }
    }
  }
  return entries;
}

function collectInstanceFiles(instanceDir: string): WalkEntry[] {
  const entries: WalkEntry[] = [];
  const stack: Array<{ abs: string; rel: string }> = [{ abs: instanceDir, rel: '' }];
  while (stack.length) {
    const current = stack.pop()!;
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(current.abs, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      const rel = current.rel ? `${current.rel}/${e.name}` : e.name;
      if (/^natives([\\/]|$)/i.test(rel)) continue;
      const full = path.join(current.abs, e.name);
      if (e.isDirectory()) stack.push({ abs: full, rel });
      else {
        try { entries.push({ rel, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime }); } catch { /* skip */ }
      }
    }
  }
  return entries;
}

async function mavenVersions(url: string): Promise<string[]> {
  const res = await fetchWithTimeout(url, { timeoutMs: 15000 });
  if (res.status >= 400) return [];
  return Array.from(res.body.toString('utf8').matchAll(/<version>([^<]+)<\/version>/g)).map(m => m[1].trim());
}

async function latestLoaderVersion(loader: LoaderType, mcVersion: string): Promise<string | null> {
  try {
    if (loader === 'fabric') {
      const list = await fetchJson<Array<{ loader: { version: string } }>>(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`, { timeoutMs: 15000 });
      return list[0]?.loader?.version ?? null;
    }
    if (loader === 'quilt') {
      const list = await fetchJson<Array<{ loader: { version: string } }>>(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`, { timeoutMs: 15000 });
      return list[0]?.loader?.version ?? null;
    }
    if (loader === 'forge') {
      const versions = await mavenVersions('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
      const matching = versions.filter(v => v.startsWith(`${mcVersion}-`));
      const last = matching[matching.length - 1];
      return last ? last.slice(mcVersion.length + 1) : null;
    }
    if (loader === 'neoforge') {
      // NeoForge 1.20.1 沿用 Forge 的 47.x
      const prefix = mcVersion === '1.20.1' ? '47.' : mcVersion.replace(/^1\./, '').replace(/\.0$/, '') + '.';
      const versions = await mavenVersions('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const matching = versions.filter(v => v.startsWith(prefix));
      return matching[matching.length - 1] ?? null;
    }
  } catch { /* 网络失败时导出不带加载器组件的包，仍可导入 */ }
  return null;
}

const LOADER_UID: Record<Exclude<LoaderType, 'vanilla'>, string> = {
  fabric: 'net.fabricmc.fabric-loader',
  quilt: 'org.quiltmc.quilt-loader',
  forge: 'net.minecraftforge',
  neoforge: 'net.neoforged',
};

export async function exportInstance(instanceId: string, format: ExportFormat, destPath: string): Promise<ExportResult> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const warnings: string[] = [];
  let entries: ZipEntryInput[] = [];

  if (format === 'mmc') {
    const loaderVersion = instance.loader === 'vanilla' ? null : (instance.loaderVersion || await latestLoaderVersion(instance.loader, instance.mcVersion));
    if (instance.loader !== 'vanilla' && !loaderVersion) warnings.push('没有确定加载器版本，导出的实例包未包含加载器组件，目标启动器可能需要手动补装。');
    const components: any[] = [{ important: true, uid: 'net.minecraft', version: instance.mcVersion }];
    if (instance.loader !== 'vanilla' && loaderVersion) {
      components.push({ important: true, uid: LOADER_UID[instance.loader], version: loaderVersion });
    }
    const mmcPack = { formatVersion: 1, components };
    const cfg = [
      'InstanceType=OneSix',
      'iconKey=default',
      `name=${instance.name.replace(/[\r\n]/g, ' ')}`,
      `notes=MCL 导出（${instance.mcVersion} ${instance.loader}）`,
      'joinServerOnLaunch=false',
      'overrideMemory=true',
      'overrideJavaArgs=false',
      'overrideConsole=false',
    ].join('\n') + '\n';
    entries.push({ name: 'mmc-pack.json', data: Buffer.from(JSON.stringify(mmcPack, null, 2), 'utf8') });
    entries.push({ name: 'instance.cfg', data: Buffer.from(cfg, 'utf8') });
    for (const e of collectGameFiles(instance.gameDir)) {
      entries.push({ name: `.minecraft/${e.rel}`, data: e.data, mtime: e.mtime });
    }
  } else if (format === 'mrpack') {
    const loaderVersion = instance.loader === 'vanilla' ? null : (instance.loaderVersion || await latestLoaderVersion(instance.loader, instance.mcVersion));
    if (instance.loader !== 'vanilla' && !loaderVersion) warnings.push('没有确定加载器版本，导出的 mrpack 可能无法被启动器正确识别。');
    const dependencies: Record<string, string> = { minecraft: instance.mcVersion };
    if (instance.loader !== 'vanilla' && loaderVersion) {
      const key = instance.loader === 'neoforge' ? 'neoforge' : `${instance.loader}-loader`;
      dependencies[key] = loaderVersion;
    }
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `mcl-export-${Date.now()}`,
      name: instance.name,
      summary: `由 MCL 导出的 ${instance.mcVersion} ${instance.loader} 整合包`,
      files: [],
      dependencies,
    };
    entries.push({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') });
    for (const e of collectGameFiles(instance.gameDir)) {
      entries.push({ name: `overrides/${e.rel}`, data: e.data, mtime: e.mtime });
    }
  } else {
    for (const e of collectInstanceFiles(paths.instanceDir(instanceId))) {
      entries.push({ name: e.rel, data: e.data, mtime: e.mtime });
    }
  }

  if (entries.length === 0) throw new Error('实例目录为空，没有可导出的文件');
  const buffer = zipWrite(entries);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
  return { filePath: destPath, format, sizeBytes: buffer.length, files: entries.length, warnings };
}

/** 为保存对话框生成默认文件名 */
export function defaultExportName(instance: InstanceInfo, format: ExportFormat): string {
  const safe = instance.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'mcl-instance';
  const ext = format === 'mrpack' ? 'mrpack' : 'zip';
  return `${safe}-${format}.${ext}`;
}