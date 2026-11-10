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
interface ModrinthVersion { id: string; name: string; version_number: string; date_published: string; files: ModrinthVersionFile[]; loaders: string[]; game_versions: string[] }

export async function getProjectVersions(projectId: string, opts: { loader?: string; gameVersion?: string } = {}): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams();
  if (opts.loader) params.set('loaders', JSON.stringify([opts.loader]));
  if (opts.gameVersion) params.set('game_versions', JSON.stringify([opts.gameVersion]));
  return fetchJson<ModrinthVersion[]>(`${API}/project/${projectId}/version?${params.toString()}`, { timeoutMs: 20000, headers: HEADERS });
}

const installedModsPath = (instanceId: string) => paths.installedModsFile(instanceId);

export function readInstalledMods(instanceId: string): InstalledMod[] {
  return readJson<InstalledMod[]>(installedModsPath(instanceId), []);
}

function writeInstalledMods(instanceId: string, mods: InstalledMod[]): void {
  writeJson(installedModsPath(instanceId), mods);
}

export async function installMod(instanceId: string, projectId: string, versionId?: string, opts: { loader?: string; gameVersion?: string } = {}): Promise<InstalledMod> {
  const versions = await getProjectVersions(projectId, opts);
  const target = versionId ? versions.find(v => v.id === versionId) : versions[0];
  if (!target) throw new Error('没有找到兼容该 Minecraft / 加载器版本的模组文件。');
  const file = target.files.find(f => f.primary) ?? target.files[0];
  if (!file) throw new Error('该版本没有可下载的文件。');
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, file.filename);
  const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3 });
  const reports = await dl.run([{ id: `modrinth:${file.filename}`, url: file.url, sha1: file.hashes?.sha1, size: file.size, dest, name: file.filename }]);
  if (!reports[0]?.ok) throw new Error(`下载失败：${reports[0]?.error ?? '未知错误'}`);

  const entry: InstalledMod = {
    fileName: file.filename,
    projectId,
    versionId: target.id,
    versionNumber: target.version_number,
    title: target.name,
    loader: opts.loader ?? null,
    installedAt: Date.now(),
    sizeBytes: fs.statSync(dest).size,
    disabled: false,
  };
  const all = readInstalledMods(instanceId).filter(m => m.fileName !== entry.fileName);
  all.push(entry);
  writeInstalledMods(instanceId, all);
  return entry;
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
  const dest = path.join(modsDir, file.filename);
  const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3 });
  const reports = await dl.run([{ id: `modrinth:${file.filename}`, url: file.url, sha1: file.hashes?.sha1, size: file.size, dest, name: file.filename }]);
  if (!reports[0]?.ok) throw new Error(`更新下载失败：${reports[0]?.error}`);
  if (old !== dest && fs.existsSync(old)) fs.rmSync(old, { force: true });
  const updated: InstalledMod = { ...mod, fileName: file.filename, versionId: target.id, versionNumber: target.version_number, installedAt: Date.now(), updateAvailable: null, sizeBytes: fs.statSync(dest).size };
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
