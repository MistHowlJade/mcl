/**
 * Modrinth API 客户端：搜索 / 版本 / 安装 / 更新检查 + Modrinth 整合包导入
 * （痛点 #33/#34/#37/#38/#40/#41/#42）
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchJson, USER_AGENT } from './net';
import * as paths from './paths';
import { InstalledMod, ModSearchResult } from '../shared/types';
import { readJson, writeJson } from './store';
import { DownloadManager } from './downloader';

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

export async function searchMods(query: string, opts: { loader?: string; gameVersion?: string; projectType?: 'mod' | 'modpack'; limit?: number; index?: 'relevance' | 'downloads' | 'follows' | 'updated' } = {}): Promise<ModSearchResult[]> {
  const facets: string[][] = [[`project_type:${opts.projectType ?? 'mod'}`]];
  if (opts.loader) facets.push([`categories:${opts.loader}`]);
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`]);
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: String(opts.limit ?? 24),
    index: opts.index ?? 'relevance',
  });
  const res = await fetchJson<{ hits: any[] }>(`${API}/search?${params.toString()}`, { timeoutMs: 20000, headers: HEADERS });
  return (res.hits ?? []).map(h => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    iconUrl: h.icon_url ?? null,
    author: h.author ?? '',
    downloads: h.downloads ?? 0,
    follows: h.follows ?? 0,
    categories: h.categories ?? [],
    gameVersions: h.versions ?? [],
    loaders: h.loaders ?? [],
  }));
}

interface ModrinthVersionFile { url: string; filename: string; hashes: { sha1?: string }; size?: number; primary?: boolean }
interface ModrinthVersion { id: string; name: string; version_number: string; date_published: string; files: ModrinthVersionFile[]; loaders: string[]; game_versions: string[]; dependencies?: Array<{ project_id?: string | null; version_id?: string | null; dependency_type: string }> }

export async function getProjectVersions(projectId: string, opts: { loader?: string; gameVersion?: string } = {}): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams();
  if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
  if (opts.gameVersion) params.set('game_versions', JSON.stringify([opts.gameVersion]));
  return fetchJson<ModrinthVersion[]>(`${API}/project/${projectId}/version?${params.toString()}`, { timeoutMs: 20000, headers: HEADERS });
}

/** 远程文件名净化：去掉目录成分，杜绝 ../ 路径穿越 */
const sanitizeRemoteName = (name: string): string => {
  const base = String(name).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return base || `file-${Date.now()}.jar`;
};

const installedModsPath = (instanceId: string) => paths.installedModsFile(instanceId);

export function readInstalledMods(instanceId: string): InstalledMod[] {
  return readJson<InstalledMod[]>(installedModsPath(instanceId), []);
}

function writeInstalledMods(instanceId: string, mods: InstalledMod[]): void {
  writeJson(installedModsPath(instanceId), mods);
}

export interface InstallResult {
  primary: InstalledMod;
  installed: InstalledMod[];
  /** 可选前置（未自动安装），project_id + 标题 */
  optionalDependencies: Array<{ projectId: string; title: string }>;
}

interface ModrinthDependency {
  project_id?: string | null;
  version_id?: string | null;
  dependency_type: string;
}

/** 安装模组：自动递归安装 required 前置（深度 ≤4、循环保护），optional 仅列出 */
export async function installMod(instanceId: string, projectId: string, versionId?: string, opts: { loader?: string; gameVersion?: string } = {}): Promise<InstallResult> {
  const visited = new Set<string>();
  const installed: InstalledMod[] = [];
  const optionalMap = new Map<string, string>();
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const downloadOne = async (fileUrl: string, sha1: string | undefined, size: number | undefined, name: string) => {
    const safeName = sanitizeRemoteName(name);
    const dest = path.join(modsDir, safeName);
    const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3 });
    const reports = await dl.run([{ id: `modrinth:${safeName}`, url: fileUrl, sha1, size, dest, name: safeName }]);
    if (!reports[0]?.ok) throw new Error(`下载失败（${safeName}）：${reports[0]?.error ?? '未知错误'}`);
    return { fileName: safeName, sizeBytes: fs.statSync(dest).size };
  };

  const installOne = async (projId: string, verId: string | undefined, depth: number, isPrimary: boolean): Promise<InstalledMod | null> => {
    if (visited.has(projId) || depth > 4) return null;
    visited.add(projId);
    const versions = await getProjectVersions(projId, opts);
    const target = verId ? versions.find(v => v.id === verId) : versions[0];
    if (!target) {
      if (isPrimary) throw new Error('没有找到兼容该 Minecraft / 加载器版本的模组文件。');
      return null; // 前置找不到：跳过，不中断主模组安装
    }
    // 先装 required 前置
    for (const dep of (target.dependencies ?? []) as ModrinthDependency[]) {
      if (dep.dependency_type === 'required' && dep.project_id) {
        await installOne(dep.project_id, dep.version_id ?? undefined, depth + 1, false);
      } else if (dep.dependency_type === 'optional' && dep.project_id && !optionalMap.has(dep.project_id)) {
        optionalMap.set(dep.project_id, dep.project_id);
      }
    }
    const file = target.files.find(f => f.primary) ?? target.files[0];
    if (!file) {
      if (isPrimary) throw new Error('该版本没有可下载的文件。');
      return null;
    }
    const { fileName, sizeBytes } = await downloadOne(file.url, file.hashes?.sha1, file.size, file.filename);
    const entry: InstalledMod = {
      fileName,
      projectId: projId,
      versionId: target.id,
      versionNumber: target.version_number,
      title: target.name,
      loader: opts.loader ?? null,
      installedAt: Date.now(),
      sizeBytes,
      disabled: false,
    };
    installed.push(entry);
    return entry;
  };

  const primary = await installOne(projectId, versionId, 0, true);
  // 合并写入 installed-mods.json（按 fileName 去重）
  const all = readInstalledMods(instanceId);
  const merged = [...all];
  for (const entry of installed) {
    const idx = merged.findIndex(m => m.fileName === entry.fileName);
    if (idx >= 0) merged[idx] = entry; else merged.push(entry);
  }
  writeInstalledMods(instanceId, merged);

  // 可选前置：补齐标题（尽力而为）
  const optionalDependencies: Array<{ projectId: string; title: string }> = [];
  for (const projectId2 of optionalMap.keys()) {
    let title = projectId2;
    try {
      const info = await fetchJson<{ title?: string }>(`${API}/project/${projectId2}`, { timeoutMs: 8000, headers: HEADERS });
      title = info?.title ?? projectId2;
    } catch { /* 标题拿不到就显示 id */ }
    optionalDependencies.push({ projectId: projectId2, title });
  }
  return { primary: primary!, installed, optionalDependencies };
}

/** 检查已安装模组的更新（尊重该实例"禁止 Mod 更新"开关，痛点 #41） */
export async function checkModUpdates(instanceId: string, mcVersion: string, loader?: string): Promise<InstalledMod[]> {
  const all = readInstalledMods(instanceId);
  if (all.length === 0) return [];
  for (const mod of all) {
    if (!mod.projectId) continue;
    try {
      const versions = await getProjectVersions(mod.projectId, { loader, gameVersion: mcVersion });
      const latest = versions[0];
      if (latest && latest.id !== mod.versionId && latest.files.length > 0) {
        mod.updateAvailable = { versionNumber: latest.version_number, fileUrl: latest.files[0].url, versionId: latest.id };
      } else {
        mod.updateAvailable = null;
      }
    } catch {
      mod.updateAvailable = null;
    }
  }
  writeInstalledMods(instanceId, all);
  return all;
}

export async function updateMod(instanceId: string, fileName: string): Promise<InstalledMod> {
  const all = readInstalledMods(instanceId);
  const mod = all.find(m => m.fileName === fileName);
  if (!mod?.projectId || !mod.updateAvailable) throw new Error('没有可用的更新');
  const versions = await getProjectVersions(mod.projectId, {});
  const target = versions.find(v => v.id === mod.updateAvailable!.versionId) ?? versions[0];
  const file = target?.files.find(f => f.primary) ?? target?.files[0];
  if (!file) throw new Error('更新文件不存在');
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  const old = path.join(modsDir, mod.fileName);
  const safeName = sanitizeRemoteName(file.filename);
  const dest = path.join(modsDir, safeName);
  const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3 });
  const reports = await dl.run([{ id: `modrinth:${safeName}`, url: file.url, sha1: file.hashes?.sha1, size: file.size, dest, name: safeName }]);
  if (!reports[0]?.ok) throw new Error(`更新下载失败：${reports[0]?.error}`);
  if (old !== dest && fs.existsSync(old)) fs.rmSync(old, { force: true });
  const updated: InstalledMod = { ...mod, fileName: safeName, versionId: target.id, versionNumber: target.version_number, installedAt: Date.now(), updateAvailable: null, sizeBytes: fs.statSync(dest).size };
  writeInstalledMods(instanceId, all.map(m => m.fileName === fileName ? updated : m));
  return updated;
}

export function toggleModDisabled(instanceId: string, fileName: string): boolean {
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  const enabled = path.join(modsDir, fileName);
  const disabled = enabled + '.disabled';
  if (fs.existsSync(enabled)) { fs.renameSync(enabled, disabled); return true; }
  if (fs.existsSync(disabled)) { fs.renameSync(disabled, enabled); return false; }
  return false;
}

export function listModFiles(instanceId: string): Array<{ fileName: string; sizeBytes: number; disabled: boolean }> {
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir)
    .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
    .map(f => ({ fileName: f, sizeBytes: fs.statSync(path.join(modsDir, f)).size, disabled: f.endsWith('.disabled') }));
}
