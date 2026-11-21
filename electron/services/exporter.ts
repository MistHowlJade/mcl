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
import * as crypto from 'crypto';
import * as paths from './paths';
import { getInstance } from './instances';
import { zipDirToFile, zipWrite, ZipEntryInput } from './zip';
import { fetchJson, fetchWithTimeout } from './net';
import { newestVersion } from './version';
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
      const last = newestVersion(matching);
      return last ? last.slice(mcVersion.length + 1) : null;
    }
    if (loader === 'neoforge') {
      // NeoForge 1.20.1 沿用 Forge 47.x，坐标为 net/neoforged/forge，版本带 1.20.1- 前缀
      if (mcVersion === '1.20.1') {
        const versions = await mavenVersions('https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml');
        const matching = versions.filter(v => v.startsWith(`${mcVersion}-47.`));
        const last = newestVersion(matching);
        return last ? last.slice(mcVersion.length + 1) : null;
      }
      // 与启动器一致：1.21 → 21.0.x（只写 "21." 会错配到 21.1/21.2）
      const parts = mcVersion.replace(/^1\./, '').split('.');
      const prefix = parts.length < 2 ? `${parts[0] || '0'}.0.` : `${parts[0]}.${parts[1]}.`;
      const versions = await mavenVersions('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const matching = versions.filter(v => v.startsWith(prefix));
      return newestVersion(matching) ?? null;
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
  if (instance.mcVersion === 'unknown' && format !== 'zip') {
    warnings.push('该实例未识别 Minecraft 版本，导出的启动器包可能无法直接导入。建议先在实例页补全版本。');
  }
  /**
   * Forge / NeoForge 的 Maven 发布坐标可能是完整 ID（1.20.1-47.2.0），
   * 而 MultiMC 组件与 Modrinth 依赖只认纯加载器版本（47.2.0）。
   * 用户手填或从旧快照恢复时两种写法都可能存在，导出前统一去掉 MC 前缀。
   */
  const normalizeLoaderVersion = (v: string | null): string | null => {
    if (!v || (instance.loader !== 'forge' && instance.loader !== 'neoforge')) return v;
    const prefix = `${instance.mcVersion}-`;
    return v.startsWith(prefix) ? v.slice(prefix.length) : v;
  };
  // 完整快照动辄数 GB：直接流式打包实例目录，不把所有文件读进内存（#18/#28）
  if (format === 'zip') {
    const partPath = `${destPath}.part`;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      const files = await zipDirToFile(paths.instanceDir(instanceId), partPath, rel => !/^natives([\\/]|$)/i.test(rel));
      fs.renameSync(partPath, destPath);
      return { filePath: destPath, format, sizeBytes: fs.statSync(destPath).size, files, warnings };
    } catch (e) {
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }

  let entries: ZipEntryInput[] = [];

  if (format === 'mmc') {
    const loaderVersion = instance.loader === 'vanilla' ? null : normalizeLoaderVersion(instance.loaderVersion || await latestLoaderVersion(instance.loader, instance.mcVersion));
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
    const loaderVersion = instance.loader === 'vanilla' ? null : normalizeLoaderVersion(instance.loaderVersion || await latestLoaderVersion(instance.loader, instance.mcVersion));
    if (instance.loader !== 'vanilla' && !loaderVersion) warnings.push('没有确定加载器版本，导出的 mrpack 可能无法被启动器正确识别。');
    const dependencies: Record<string, string> = { minecraft: instance.mcVersion };
    if (instance.loader !== 'vanilla' && loaderVersion) {
      // Modrinth 规范的键：forge / neoforge / fabric-loader / quilt-loader
      const key = instance.loader === 'fabric' ? 'fabric-loader' : instance.loader === 'quilt' ? 'quilt-loader' : instance.loader;
      dependencies[key] = loaderVersion;
    }
    // Modrinth 规范：mods 应写进 files[]（带下载地址与 hash）供其他启动器管理；
    // 只有在 Modrinth 上查不到来源的 jar 才退回 overrides/，否则清单恒为空。
    const modFiles: Array<Record<string, unknown>> = [];
    const overrideFiles: WalkEntry[] = [];
    let untrackedMods = 0;
    const gameFiles = collectGameFiles(instance.gameDir);
    const jars = gameFiles.filter(e => e.rel.startsWith('mods/') && /\.jar$/i.test(e.rel));
    type Lookup = { sha1: string; file?: { url?: string; hashes?: Record<string, string>; size?: number } };
    const lookups = new Array<Lookup>(jars.length);
    // 并发查询（上限 6）：断网时不再按模组数线性叠加 10s 超时
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(6, jars.length) }, async () => {
      while (cursor < jars.length) {
        const i = cursor++;
        const e = jars[i];
        const sha1 = crypto.createHash('sha1').update(e.data).digest('hex');
        let file: Lookup['file'];
        try {
          const versions = await fetchJson<Array<{ files?: Array<NonNullable<Lookup['file']>> }>>(
            `https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`, { timeoutMs: 10000 });
          file = (Array.isArray(versions) ? versions : [])
            .flatMap(v => Array.isArray(v?.files) ? v.files : [])
            .find(f => f?.url && (f.hashes?.sha1 ?? '').toLowerCase() === sha1);
        } catch { /* 查询失败当作查不到来源 */ }
        lookups[i] = { sha1, file };
      }
    }));
    const lookupByRel = new Map<string, Lookup>();
    jars.forEach((e, i) => lookupByRel.set(e.rel, lookups[i]));
    for (const e of gameFiles) {
      if (e.rel.startsWith('mods/') && /\.jar$/i.test(e.rel)) {
        const hit = lookupByRel.get(e.rel);
        if (hit?.file?.url) {
          const f = hit.file;
          modFiles.push({
            path: e.rel,
            hashes: { sha1: f.hashes?.sha1 ?? hit.sha1, ...(f.hashes?.sha512 ? { sha512: f.hashes.sha512 } : {}) },
            downloads: [f.url],
            fileSize: f.size ?? e.data.length,
          });
          continue;
        }
        untrackedMods++;
      }
      overrideFiles.push(e);
    }
    if (untrackedMods > 0) warnings.push(`${untrackedMods} 个模组在 Modrinth 上未找到来源，已放入 overrides/，其它启动器不会将其列为可管理模组。`);
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `mcl-export-${Date.now()}`,
      name: instance.name,
      summary: `由 MCL 导出的 ${instance.mcVersion} ${instance.loader} 整合包`,
      files: modFiles,
      dependencies,
    };
    entries.push({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index, null, 2), 'utf8') });
    for (const e of overrideFiles) {
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
  // 覆盖已有导出文件时先写同目录 .part 再改名：中途失败不会留下半个 ZIP 把原文件也毁掉
  const partPath = `${destPath}.part`;
  try {
    fs.writeFileSync(partPath, buffer);
    fs.renameSync(partPath, destPath);
  } catch (e) {
    try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return { filePath: destPath, format, sizeBytes: buffer.length, files: entries.length, warnings };
}

/** 为保存对话框生成默认文件名 */
export function defaultExportName(instance: InstanceInfo, format: ExportFormat): string {
  const safe = instance.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'mcl-instance';
  const ext = format === 'mrpack' ? 'mrpack' : 'zip';
  return `${safe}-${format}.${ext}`;
}