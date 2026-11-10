/**
 * 整合包导入：自动识别格式 + 嵌套目录剥离（痛点 #35/#39）
 * 支持：Modrinth (modrinth.index.json) / CurseForge (manifest.json) / MultiMC 系 (mmc-pack.json)
 * CurseForge 官方 API 需要密钥；没有密钥时给出逐项下载链接，绝不悄悄失败（痛点 #36）
 */
import * as fs from 'fs';
import * as path from 'path';
import { zipList, zipExtractEntry } from './zip';
import { createInstance, listInstances, updateInstance } from './instances';
import * as paths from './paths';
import { fetchJson, USER_AGENT } from './net';
import { DownloadManager } from './downloader';
import { getSettings } from './settings';
import { LoaderType, MemoryPreset } from '../shared/types';

export type ModpackFormat = 'modrinth' | 'curseforge' | 'mmc' | 'unknown';
export interface ImportResult {
  instanceId: string | null;
  format: ModpackFormat;
  importedMods: number;
  skippedFiles: string[];
  warnings: string[];
  /** CurseForge 无密钥时：每个需要手动下载的 mod 链接 */
  manualDownloads?: Array<{ name: string; url: string }>;
}

interface PackEntry { name: string }

/** 在 zip 中查找打包格式的入口文件（允许嵌套 ≤4 层目录），返回剥离前缀 */
function findPackRoot(entries: PackEntry[]): { format: ModpackFormat; prefix: string } | null {
  const candidates: Array<{ file: string; format: ModpackFormat }> = [
    { file: 'modrinth.index.json', format: 'modrinth' },
    { file: 'manifest.json', format: 'curseforge' },
    { file: 'mmc-pack.json', format: 'mmc' },
  ];
  for (const { file, format } of candidates) {
    const hit = entries.find(e => {
      const norm = e.name.replace(/\\/g, '/');
      const segs = norm.split('/').filter(Boolean);
      return segs[segs.length - 1] === file && segs.length - 1 <= 4;
    });
    if (hit) {
      const idx = hit.name.lastIndexOf('/');
      return { format, prefix: idx >= 0 ? hit.name.slice(0, idx + 1) : '' };
    }
  }
  return null;
}

const stripPrefix = (name: string, prefix: string) => name.replace(/\\/g, '/').slice(prefix.length);
const safeTarget = (root: string, rel: string): string | null => {
  const target = path.resolve(root, rel);
  return target.startsWith(path.resolve(root) + path.sep) ? target : null;
};

export async function importModpack(zipPath: string, targetName?: string, onLog?: (line: string) => void): Promise<ImportResult> {
  const log = onLog ?? (() => {});
  const buf = fs.readFileSync(zipPath);
  const entries = zipList(buf);
  const root = findPackRoot(entries);
  if (!root) {
    return { instanceId: null, format: 'unknown', importedMods: 0, skippedFiles: [], warnings: ['无法识别的整合包格式：找不到 modrinth.index.json / manifest.json / mmc-pack.json。支持 Modrinth、CurseForge 与 MultiMC 整合包。'] };
  }
  const { format, prefix } = root;
  log(`识别到 ${format} 格式整合包${prefix ? `（根目录：${prefix}）` : ''}`);

  const readEntry = (fileName: string): Buffer | null => {
    const hit = entries.find(e => e.name.replace(/\\/g, '/') === prefix + fileName);
    return hit ? zipExtractEntry(buf, hit) : null;
  };

  const warnings: string[] = [];
  const skippedFiles: string[] = [];

  const copyOverrides = (overridesDirName: string, destGameDir: string) => {
    const overPrefix = prefix + overridesDirName + '/';
    let count = 0;
    for (const entry of entries) {
      const norm = entry.name.replace(/\\/g, '/');
      if (!norm.startsWith(overPrefix) || norm.endsWith('/')) continue;
      const rel = stripPrefix(norm, overPrefix);
      const target = safeTarget(destGameDir, rel);
      if (!target) { warnings.push(`已跳过可疑路径：${norm}`); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, zipExtractEntry(buf, entry));
      count++;
    }
    return count;
  };

  if (format === 'modrinth') {
    const index = JSON.parse(readEntry('modrinth.index.json')!.toString('utf8'));
    const mcVersion: string = index?.dependencies?.minecraft ?? '1.20.1';
    let loader: LoaderType = 'vanilla';
    let loaderVersion: string | null = null;
    if (index?.dependencies?.['fabric-loader']) { loader = 'fabric'; loaderVersion = String(index.dependencies['fabric-loader']); }
    else if (index?.dependencies?.['quilt-loader']) { loader = 'quilt'; loaderVersion = String(index.dependencies['quilt-loader']); }
    else if (index?.dependencies?.forge) { loader = 'forge'; loaderVersion = String(index.dependencies.forge); }
    else if (index?.dependencies?.neoforge) { loader = 'neoforge'; loaderVersion = String(index.dependencies.neoforge); }
    const instance = createInstance({ name: targetName ?? index.name ?? 'Modrinth 整合包', mcVersion, loader, loaderVersion, memoryPreset: 'heavy' });
    const game = paths.gameDir(instance.id);
    // 下载 files
    const files: Array<{ downloads: string[]; path: string; hashes?: { sha1?: string; sha512?: string }; size?: number }> = index.files ?? [];
    log(`需要下载 ${files.length} 个文件…`);
    const tasks = files.map((f, i) => ({
      id: `packfile:${i}`,
      url: f.downloads[0],
      sha1: f.hashes?.sha1,
      size: f.size,
      dest: safeTarget(game, f.path) ?? path.join(game, 'pack-files', path.basename(f.path)),
      name: path.basename(f.path),
    }));
    const dl = new DownloadManager({ source: getSettings().download.source, maxThreads: getSettings().download.maxThreads, retries: 3, timeoutMs: getSettings().download.timeoutMs });
    const reports = await dl.run(tasks);
    const ok = reports.filter(r => r.ok).length;
    for (const r of reports) if (!r.ok) { skippedFiles.push(r.name); warnings.push(`下载失败：${r.name}（${r.error}）`); }
    const overridden = copyOverrides('overrides', game);
    log(`完成：${ok}/${files.length} 个文件下载成功，overrides ${overridden} 个文件，实例已创建。`);
    return { instanceId: instance.id, format, importedMods: ok, skippedFiles, warnings };
  }

  if (format === 'curseforge') {
    const manifest = JSON.parse(readEntry('manifest.json')!.toString('utf8'));
    const mcVersion: string = manifest?.minecraft?.version ?? '1.20.1';
    const modLoaderEntry = (manifest?.minecraft?.modLoaders ?? []).find((l: any) => l.primary) ?? manifest?.minecraft?.modLoaders?.[0];
    let loader: LoaderType = 'vanilla';
    let loaderVersion: string | null = null;
    const idStr: string = modLoaderEntry?.id ?? '';
    const m = idStr.match(/^(forge|fabric|quilt|neoforge)-(.+)$/);
    if (m) { loader = m[1] as LoaderType; loaderVersion = m[2]; }
    const instance = createInstance({ name: targetName ?? manifest?.name ?? 'CurseForge 整合包', mcVersion, loader, loaderVersion, memoryPreset: 'heavy' as MemoryPreset });
    const game = paths.gameDir(instance.id);
    copyOverrides('overrides', game);
    const files: Array<{ projectID: number; fileID: number }> = manifest?.files ?? [];
    const apiKey = getSettings().curseforge.apiKey.trim();
    if (apiKey) {
      log(`使用 CurseForge API 下载 ${files.length} 个模组…`);
      const manual: Array<{ name: string; url: string }> = [];
      let ok = 0;
      for (const f of files) {
        try {
          const info = await fetchJson<{ data: { downloadUrl: string | null; fileName: string } }>(`https://api.curseforge.com/v1/mods/${f.projectID}/files/${f.fileID}`, { timeoutMs: 20000, headers: { 'x-api-key': apiKey, 'User-Agent': USER_AGENT } });
          const url = info?.data?.downloadUrl;
          if (!url) { manual.push({ name: `CF project ${f.projectID}`, url: `https://www.curseforge.com/projects/${f.projectID}/files/${f.fileID}` }); continue; }
          const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 2 });
          const reports = await dl.run([{ id: `cf:${f.fileID}`, url, dest: path.join(game, 'mods', info.data.fileName), name: info.data.fileName }]);
          if (reports[0]?.ok) ok++; else manual.push({ name: info.data.fileName, url });
        } catch {
          manual.push({ name: `CF project ${f.projectID}`, url: `https://www.curseforge.com/projects/${f.projectID}/files/${f.fileID}` });
        }
      }
      warnings.push(...manual.map(x => `需手动下载：${x.name} → ${x.url}`));
      return { instanceId: instance.id, format, importedMods: ok, skippedFiles: skippedFiles, warnings, manualDownloads: manual.length ? manual : undefined };
    }
    // 无密钥：给出逐项链接（痛点 #36：绝不静默失败）
    warnings.push('未配置 CurseForge API 密钥：已创建实例并复制 overrides，但模组需要手动下载。可在设置 → CurseForge API 中填写密钥后重新导入，或点下面的链接逐个下载放入 mods 目录。');
    const manualDownloads = files.map(f => ({ name: `project ${f.projectID} / file ${f.fileID}`, url: `https://www.curseforge.com/projects/${f.projectID}/files/${f.fileID}/download` }));
    return { instanceId: instance.id, format, importedMods: 0, skippedFiles: files.map(f => `${f.projectID}/${f.fileID}`), warnings, manualDownloads };
  }

  // MultiMC/紧凑格式：整个包就是实例内容（除 mmc-pack.json 本身）
  const instance = createInstance({ name: targetName ?? path.basename(zipPath, '.zip'), mcVersion: '1.20.1', loader: 'vanilla', memoryPreset: 'standard' });
  const game = paths.gameDir(instance.id);
  let mmcJson: any = null;
  try { mmcJson = JSON.parse(readEntry('mmc-pack.json')!.toString('utf8')); } catch { warnings.push('mmc-pack.json 解析失败，按 vanilla 1.20.1 创建'); }
  if (mmcJson?.components) {
    const mc = mmcJson.components.find((c: any) => c?.uid === 'net.minecraft');
    const loaderComp = mmcJson.components.find((c: any) => ['net.fabricmc.fabric-loader', 'net.minecraftforge', 'org.quiltmc.quilt-loader', 'net.neoforged'].includes(c?.uid));
    if (mc?.version) {
      updateInstanceMcVersion(instance.id, mc.version);
    }
    if (loaderComp) {
      const loaderType: LoaderType = loaderComp.uid === 'net.fabricmc.fabric-loader' ? 'fabric' : loaderComp.uid === 'org.quiltmc.quilt-loader' ? 'quilt' : loaderComp.uid === 'net.neoforged' ? 'neoforge' : 'forge';
      updateInstance(instance.id, { loader: loaderType, loaderVersion: loaderComp.version ?? null });
      warnings.push('MultiMC 整合包已转换为 MCL 实例，加载器将在首次启动时安装。');
    }
  }
  let copied = 0;
  for (const entry of entries) {
    const norm = entry.name.replace(/\\/g, '/');
    if (!norm.startsWith(prefix) || norm.endsWith('/')) continue;
    const rel = stripPrefix(norm, prefix);
    if (rel === 'mmc-pack.json') continue;
    const target = safeTarget(game, rel);
    if (!target) { warnings.push(`已跳过可疑路径：${norm}`); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zipExtractEntry(buf, entry));
    copied++;
  }
  warnings.push(`MultiMC 格式：整包直接展开为实例目录（${copied} 个文件）。`);
  return { instanceId: instance.id, format, importedMods: copied, skippedFiles, warnings };
}

function updateInstanceMcVersion(id: string, mcVersion: string): void {
  updateInstance(id, { mcVersion });
}
