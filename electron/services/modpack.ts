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

/** CurseForge 文件信息：只声明用到的字段，algo 1 = SHA-1 */
interface CurseForgeFileInfo {
  downloadUrl: string | null;
  fileName: string;
  fileLength?: number;
  hashes?: Array<{ value?: string; algo?: number }>;
}

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
      // 必须用归一化后的路径计算前缀，Windows 打包的 ZIP 可能用反斜杠
      const norm = hit.name.replace(/\\/g, '/');
      const idx = norm.lastIndexOf('/');
      return { format, prefix: idx >= 0 ? norm.slice(0, idx + 1) : '' };
    }
  }
  return null;
}

const stripPrefix = (name: string, prefix: string) => name.replace(/\\/g, '/').slice(prefix.length);
/** 远程文件名净化：去掉目录成分，杜绝 ../ 路径穿越 */
const sanitizeRemoteName = (name: string): string => {
  const base = String(name).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return base || `file-${Date.now()}`;
};
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
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, zipExtractEntry(buf, entry));
        count++;
      } catch (e) {
        // 单个覆盖文件失败不应让整个整合包导入中断，记录下来让用户知道
        warnings.push(`覆盖文件写入失败：${norm}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    return count;
  };

  if (format === 'modrinth') {
    let index: any;
    try { index = JSON.parse(readEntry('modrinth.index.json')!.toString('utf8')); }
    catch { throw new Error('整合包索引 modrinth.index.json 不是有效 JSON，文件可能已损坏。'); }
    const mcVersion: string = String(index?.dependencies?.minecraft ?? '1.20.1');
    let loader: LoaderType = 'vanilla';
    let loaderVersion: string | null = null;
    if (index?.dependencies?.['fabric-loader']) { loader = 'fabric'; loaderVersion = String(index.dependencies['fabric-loader']); }
    else if (index?.dependencies?.['quilt-loader']) { loader = 'quilt'; loaderVersion = String(index.dependencies['quilt-loader']); }
    else if (index?.dependencies?.forge) { loader = 'forge'; loaderVersion = String(index.dependencies.forge); }
    else if (index?.dependencies?.neoforge) { loader = 'neoforge'; loaderVersion = String(index.dependencies.neoforge); }
    const instance = createInstance({ name: targetName ?? index.name ?? 'Modrinth 整合包', mcVersion, loader, loaderVersion, memoryPreset: 'heavy' });
    const game = paths.gameDir(instance.id);
    // 下载 files（跳过服务端专用文件 env.client === 'unsupported'）
    const rawFiles = index?.files;
    if (!Array.isArray(rawFiles)) warnings.push('整合包索引里的 files 字段不是数组，可能已损坏；实例已创建但没有自动下载模组。');
    const files: Array<{ downloads: string[]; path: string; hashes?: { sha1?: string; sha512?: string }; size?: number; env?: { client?: string } }> = Array.isArray(rawFiles) ? rawFiles : [];
    let skippedServer = 0;
    let invalidFiles = 0;
    const downloadable = files.filter(f => {
      if (f?.env?.client === 'unsupported') { skippedServer++; return false; }
      if (!Array.isArray(f?.downloads) || typeof f.downloads[0] !== 'string' || !f.downloads[0]) { invalidFiles++; return false; }
      if (typeof f?.path !== 'string' || !f.path.trim()) { invalidFiles++; return false; }
      return true;
    });
    if (skippedServer > 0) warnings.push(`已跳过 ${skippedServer} 个服务端专用文件（env.client = unsupported）。`);
    if (invalidFiles > 0) warnings.push(`已跳过 ${invalidFiles} 个没有下载地址的文件（整合包索引可能不完整）。`);
    log(`需要下载 ${downloadable.length} 个文件（已过滤 ${skippedServer} 个服务端文件）…`);
    const tasks = downloadable.map((f, i) => ({
      id: `packfile:${i}`,
      url: f.downloads[0],
      sha1: f.hashes?.sha1,
      size: f.size,
      dest: safeTarget(game, f.path) ?? path.join(game, 'pack-files', sanitizeRemoteName(f.path.split('/').pop() ?? `file-${i}`)),
      name: sanitizeRemoteName(f.path.split('/').pop() ?? `file-${i}`),
    }));
    const downloadSettings = getSettings().download;
    const dl = new DownloadManager({
      source: downloadSettings.source,
      customMirror: downloadSettings.customMirror,
      maxThreads: downloadSettings.maxThreads,
      retries: 3,
      timeoutMs: downloadSettings.timeoutMs,
    });
    const reports = await dl.run(tasks);
    const ok = reports.filter(r => r.ok).length;
    for (const r of reports) if (!r.ok) { skippedFiles.push(r.name); warnings.push(`下载失败：${r.name}（${r.error}）`); }
    const overridden = copyOverrides('overrides', game);
    const clientOverridden = copyOverrides('client-overrides', game); // 客户端覆盖层：同名文件覆盖 overrides
    log(`完成：${ok}/${downloadable.length} 个文件下载成功，overrides ${overridden} 个、client-overrides ${clientOverridden} 个文件，实例已创建。`);
    return { instanceId: instance.id, format, importedMods: ok, skippedFiles, warnings };
  }

  if (format === 'curseforge') {
    let manifest: any;
    try { manifest = JSON.parse(readEntry('manifest.json')!.toString('utf8')); }
    catch { throw new Error('整合包清单 manifest.json 不是有效 JSON，文件可能已损坏。'); }
    const mcVersion: string = String(manifest?.minecraft?.version ?? '1.20.1');
    const rawLoaders = manifest?.minecraft?.modLoaders;
    const modLoaderEntry = (Array.isArray(rawLoaders) ? rawLoaders : []).find((l: any) => l?.primary)
      ?? (Array.isArray(rawLoaders) ? rawLoaders[0] : undefined);
    let loader: LoaderType = 'vanilla';
    let loaderVersion: string | null = null;
    const idStr: string = modLoaderEntry?.id ?? '';
    const m = idStr.match(/^(forge|fabric|quilt|neoforge)-(.+)$/);
    if (m) { loader = m[1] as LoaderType; loaderVersion = m[2]; }
    const instance = createInstance({ name: targetName ?? manifest?.name ?? 'CurseForge 整合包', mcVersion, loader, loaderVersion, memoryPreset: 'heavy' as MemoryPreset });
    const game = paths.gameDir(instance.id);
    copyOverrides('overrides', game);
    const rawCfFiles = Array.isArray(manifest?.files) ? manifest.files : [];
    // 清单里的 projectID/fileID 必须是正整数：否则会拼出 /mods/undefined/files/undefined 的无效请求
    const files: Array<{ projectID: number; fileID: number }> = rawCfFiles.filter((f: any) =>
      Number.isInteger(f?.projectID) && f.projectID > 0 && Number.isInteger(f?.fileID) && f.fileID > 0);
    if (files.length !== rawCfFiles.length) {
      warnings.push(`已跳过 ${rawCfFiles.length - files.length} 个缺少有效 projectID/fileID 的条目。`);
    }
    const apiKey = getSettings().curseforge.apiKey.trim();
    if (apiKey) {
      log(`使用 CurseForge API 下载 ${files.length} 个模组…`);
      const manual: Array<{ name: string; url: string }> = [];
      let ok = 0;
      for (const f of files) {
        try {
          const info = await fetchJson<{ data: CurseForgeFileInfo }>(`https://api.curseforge.com/v1/mods/${f.projectID}/files/${f.fileID}`, { timeoutMs: 20000, headers: { 'x-api-key': apiKey, 'User-Agent': USER_AGENT } });
          const file = info?.data;
          const url = file?.downloadUrl;
          if (!file || !url) { manual.push({ name: `CF project ${f.projectID}`, url: `https://www.curseforge.com/projects/${f.projectID}/files/${f.fileID}` }); continue; }
          const safeName = sanitizeRemoteName(file.fileName || `cf-${f.projectID}-${f.fileID}.jar`);
          // API 返回的 SHA-1 / 文件大小是唯一能证明下载完整性的依据：
          // 被墙或被劫持时服务器可能返回 200 的 HTML 错误页，不能把这种文件当模组装进 mods
          const sha1 = (Array.isArray(file.hashes) ? file.hashes : [])
            .find(h => h?.algo === 1 && /^[a-f0-9]{40}$/i.test(String(h?.value ?? '')))?.value;
          const size = typeof file.fileLength === 'number' && Number.isInteger(file.fileLength) && file.fileLength > 0
            ? file.fileLength
            : undefined;
          const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 2 });
          const reports = await dl.run([{ id: `cf:${f.fileID}`, url, dest: path.join(game, 'mods', safeName), name: safeName, sha1, size }]);
          if (reports[0]?.ok) ok++; else manual.push({ name: file.fileName || safeName, url });
        } catch {
          manual.push({ name: `CF project ${f.projectID}`, url: `https://www.curseforge.com/projects/${f.projectID}/files/${f.fileID}` });
        }
      }
      for (const m of manual) skippedFiles.push(m.name);
      warnings.push(...manual.map(x => `需手动下载：${x.name} → ${x.url}`));
      return { instanceId: instance.id, format, importedMods: ok, skippedFiles, warnings, manualDownloads: manual.length ? manual : undefined };
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
  if (Array.isArray(mmcJson?.components)) {
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
  // MultiMC/Prism 各版本导出包可能用 minecraft/ 或 .minecraft/；
  // MCL 自己导出的包用的是 .minecraft/，两种都要认，否则回导会落到 game/.minecraft/ 下读不到
  const normalizedNames = entries.map(e => e.name.replace(/\\/g, '/'));
  const gameSub = normalizedNames.some(n => n.startsWith(`${prefix}minecraft/`)) ? 'minecraft/'
    : normalizedNames.some(n => n.startsWith(`${prefix}.minecraft/`)) ? '.minecraft/' : '';
  const hasMinecraftDir = !!gameSub;
  const gamePrefix = prefix + gameSub;
  const SKIP_META = new Set(['instance.cfg', 'mmc-pack.json', 'icon.png', 'instance.png', 'logo.png']);
  let copied = 0, modsCopied = 0, savesCopied = 0;
  for (const entry of entries) {
    const norm = entry.name.replace(/\\/g, '/');
    if (!norm.startsWith(gamePrefix) || norm.endsWith('/')) continue;
    const rel = stripPrefix(norm, gamePrefix);
    if (!rel) continue;
    if (SKIP_META.has(rel.split('/')[0])) continue;   // 跳过实例元数据（instance.cfg 等）
    const target = safeTarget(game, rel);
    if (!target) { warnings.push(`已跳过可疑路径：${norm}`); continue; }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, zipExtractEntry(buf, entry));
      copied++;
      if (rel.startsWith('mods/')) modsCopied++;
      else if (rel.startsWith('saves/')) savesCopied++;
    } catch (e) {
      warnings.push(`文件写入失败：${norm}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  log(`已复制 mods ${modsCopied} 个、saves ${savesCopied} 个、共 ${copied} 个文件${hasMinecraftDir ? '（minecraft/ 前缀已剥离）' : ''}`);
  warnings.push(`MultiMC 格式：${hasMinecraftDir ? '已识别 minecraft/ 游戏目录，' : ''}整包展开为实例目录（${copied} 个文件：mods ${modsCopied}、saves ${savesCopied}）。`);
  return { instanceId: instance.id, format, importedMods: copied, skippedFiles, warnings };
}

function updateInstanceMcVersion(id: string, mcVersion: string): void {
  updateInstance(id, { mcVersion });
}
