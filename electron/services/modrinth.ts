/**
 * Modrinth API 客户端：搜索 / 版本 / 安装 / 更新检查 + Modrinth 整合包导入
 * （痛点 #33/#34/#37/#38/#40/#41/#42）
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchJson, USER_AGENT } from './net';
import * as paths from './paths';
import { ContentInstallResult, ContentProjectType, InstalledMod, ModSearchResult } from '../shared/types';
import { readJson, writeJson } from './store';
import { DownloadManager } from './downloader';
import { importWorldZip } from './content';
import { getInstance } from './instances';

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

/** 实例 ID 来自渲染进程：先确认实例存在，路径拼接才不会跑到数据目录之外 */
function assertInstance(instanceId: string): void {
  if (!getInstance(instanceId)) throw new Error('实例不存在');
}

export async function searchMods(query: string, opts: { loader?: string; gameVersion?: string; projectType?: 'mod' | 'modpack'; limit?: number; index?: 'relevance' | 'downloads' | 'follows' | 'updated' } = {}): Promise<ModSearchResult[]> {
  return searchContent(query, { ...opts, projectType: opts.projectType ?? 'mod' });
}

/** 通用 Modrinth 搜索：模组 / 整合包 / 资源包 / 光影 / 数据包 / 世界 */
export async function searchContent(
  query: string,
  opts: { projectType: ContentProjectType; loader?: string; gameVersion?: string; limit?: number; index?: 'relevance' | 'downloads' | 'follows' | 'updated' } = { projectType: 'mod' },
): Promise<ModSearchResult[]> {
  const facets: string[][] = [[`project_type:${opts.projectType}`]];
  // 只有模组/整合包有加载器概念；资源包/光影/世界/数据包不加 categories 过滤
  if (opts.loader && (opts.projectType === 'mod' || opts.projectType === 'modpack')) facets.push([`categories:${opts.loader}`]);
  // 世界存档通常不标注游戏版本，强行过滤会漏掉大量结果
  if (opts.gameVersion && opts.projectType !== 'world') facets.push([`versions:${opts.gameVersion}`]);
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

/** 远程文件名净化：去掉目录成分并过滤 Windows 非法字符，杜绝 ../ 路径穿越与非法文件名 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const sanitizeRemoteName = (name: string): string => {
  const base = String(name).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  let cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');   // Windows 会吞掉结尾的点和空格
  // 截断时保留扩展名，否则超长文件名会丢掉 .jar 导致模组不被加载
  if (cleaned.length > 150) {
    const ext = path.extname(cleaned);
    const keep = Math.max(1, 150 - ext.length);
    cleaned = cleaned.slice(0, keep).replace(/[. ]+$/g, '') + ext;
  }
  if (!cleaned || /^\.+$/.test(cleaned)) cleaned = `file-${Date.now()}.jar`;
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
};

const installedModsPath = (instanceId: string) => paths.installedModsFile(instanceId);

export function readInstalledMods(instanceId: string): InstalledMod[] {
  assertInstance(instanceId);
  const raw = readJson<unknown>(installedModsPath(instanceId), []);
  // 文件可能被手工改坏成 null/对象：按空列表处理，避免 Mods 页面整页报错。
  // fileName 会参与 mods 目录下的删除/重命名，必须只接受不带路径的 jar 文件名。
  return Array.isArray(raw)
    ? raw.filter((m): m is InstalledMod => !!m && typeof m === 'object'
      && typeof (m as InstalledMod).fileName === 'string'
      && /^[^\\/:*?"<>|]+\.jar(\.disabled)?$/i.test((m as InstalledMod).fileName))
    : [];
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
  assertInstance(instanceId);
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
    // 同名文件之前可能被禁用（foo.jar.disabled）：新文件已启用，必须清掉旧副本，
    // 否则两者并存，之后点「禁用/启用」会被安全检查直接拒绝
    try { fs.rmSync(`${dest}.disabled`, { force: true }); } catch { /* 删不掉不阻断安装 */ }
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
    // 同一 project 换了文件名时删掉旧 jar，避免 mods 目录里新旧版本并存（常见崩溃原因）
    for (let i = merged.length - 1; i >= 0; i--) {
      const old = merged[i];
      if (old.projectId && old.projectId === entry.projectId && old.fileName !== entry.fileName) {
        const oldPath = path.join(modsDir, old.fileName);
        for (const p of [oldPath, `${oldPath}.disabled`]) {
          try { fs.rmSync(p, { force: true }); } catch { /* 旧文件删不掉不阻断安装 */ }
        }
        merged.splice(i, 1);
      }
    }
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

/** 下载并安装资源包 / 光影 / 世界（世界会解压到 saves 下） */
export async function installContent(
  instanceId: string,
  projectId: string,
  versionId: string | null,
  kind: 'resourcepacks' | 'shaderpacks' | 'worlds',
  opts: { gameVersion?: string; loader?: string } = {},
): Promise<ContentInstallResult> {
  assertInstance(instanceId);
  // kind 在 IPC 边界只是 TS 类型，运行时要再确认一次，否则可拼接出实例目录之外的路径
  if (!['resourcepacks', 'shaderpacks', 'worlds'].includes(kind)) throw new Error('不支持的内容类型');
  const versions = await getProjectVersions(projectId, {
    // 世界存档通常不标注游戏版本
    gameVersion: kind === 'worlds' ? undefined : opts.gameVersion,
    // 资源包/光影/世界没有加载器筛选
    loader: kind === 'worlds' || kind === 'resourcepacks' || kind === 'shaderpacks' ? undefined : opts.loader,
  });
  const target = versionId ? versions.find(v => v.id === versionId) : versions[0];
  if (!target) throw new Error('没有找到兼容该 Minecraft 版本的文件。');
  const file = target.files.find(f => f.primary) ?? target.files[0];
  if (!file) throw new Error('该版本没有可下载的文件。');
  const safeName = sanitizeRemoteName(file.filename);

  const downloadTo = async (dest: string) => {
    const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3, timeoutMs: 30000 });
    const reports = await dl.run([{ id: `modrinth-content:${safeName}`, url: file.url, sha1: file.hashes?.sha1, size: file.size, dest, name: safeName }]);
    if (!reports[0]?.ok) throw new Error(`下载失败（${safeName}）：${reports[0]?.error ?? '未知错误'}`);
    return fs.statSync(dest).size;
  };

  if (kind === 'worlds') {
    const temp = path.join(paths.cacheDir(), `mcl-world-${Date.now()}-${safeName}`);
    try {
      const sizeBytes = await downloadTo(temp);
      const imported = importWorldZip(instanceId, temp);
      return { fileName: safeName, path: imported.path, sizeBytes, worldName: imported.worldName };
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    }
  }

  const dir = path.join(paths.gameDir(instanceId), kind);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName);
  const sizeBytes = await downloadTo(dest);
  return { fileName: safeName, path: dest, sizeBytes };
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
      const latestFile = latest?.files.find(f => f.primary) ?? latest?.files[0];
      if (latest && latestFile && latest.id !== mod.versionId) {
        mod.updateAvailable = { versionNumber: latest.version_number, fileUrl: latestFile.url, versionId: latest.id };
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
  // 禁用状态在磁盘上是 foo.jar.disabled，installed-mods.json 里记录的仍是 foo.jar
  const baseName = path.basename(String(fileName ?? '')).replace(/\.disabled$/i, '');
  const mod = all.find(m => m.fileName === baseName);
  if (!mod?.projectId || !mod.updateAvailable) throw new Error('没有可用的更新');
  const versions = await getProjectVersions(mod.projectId, {});
  // 必须精确命中检查更新时选中的版本：拿不到就报错，不能退回到可能不兼容的最新版
  const target = versions.find(v => v.id === mod.updateAvailable!.versionId);
  if (!target) throw new Error('更新版本已不可用，请重新检查更新后再试');
  const file = target.files.find(f => f.primary) ?? target.files[0];
  if (!file) throw new Error('更新文件不存在');
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  const old = path.join(modsDir, mod.fileName);
  const safeName = sanitizeRemoteName(file.filename);
  const dest = path.join(modsDir, safeName);
  const dl = new DownloadManager({ source: 'official', maxThreads: 2, retries: 3 });
  const reports = await dl.run([{ id: `modrinth:${safeName}`, url: file.url, sha1: file.hashes?.sha1, size: file.size, dest, name: safeName }]);
  if (!reports[0]?.ok) throw new Error(`更新下载失败：${reports[0]?.error}`);
  // 旧文件可能仍处于禁用状态（.disabled），一并清理
  for (const candidate of [old, `${old}.disabled`]) {
    if (candidate !== dest && fs.existsSync(candidate)) fs.rmSync(candidate, { force: true });
  }
  const updated: InstalledMod = { ...mod, fileName: safeName, versionId: target.id, versionNumber: target.version_number, installedAt: Date.now(), updateAvailable: null, sizeBytes: fs.statSync(dest).size };
  writeInstalledMods(instanceId, all.map(m => m.fileName === baseName ? updated : m));
  return updated;
}

export function toggleModDisabled(instanceId: string, fileName: string): boolean {
  assertInstance(instanceId);
  // 只允许操作 mods 目录里的 jar：fileName 不能带目录分隔符或 ..
  // 界面对已禁用文件传的是 foo.jar.disabled，先还原成 foo.jar，
  // 否则会把 .disabled 当成正常扩展名再禁用一次（foo.jar.disabled.disabled）
  const base = path.basename(String(fileName ?? '')).replace(/\.disabled$/i, '');
  if (!/^[^\\/]+\.jar$/i.test(base)) throw new Error('模组文件名不合法');
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  const enabled = path.join(modsDir, base);
  const disabled = enabled + '.disabled';
  if (fs.existsSync(enabled)) {
    if (fs.existsSync(disabled)) {
      throw new Error(`mods 目录同时存在 ${base} 和 ${base}.disabled，请先手动删除一个重复文件`);
    }
    fs.renameSync(enabled, disabled);
    return true;
  }
  if (fs.existsSync(disabled)) { fs.renameSync(disabled, enabled); return false; }
  return false;
}

export function listModFiles(instanceId: string): Array<{ fileName: string; sizeBytes: number; disabled: boolean }> {
  assertInstance(instanceId);
  const modsDir = path.join(paths.gameDir(instanceId), 'mods');
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir)
    .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
    .map(f => {
      let sizeBytes = 0;
      try { sizeBytes = fs.statSync(path.join(modsDir, f)).size; } catch { /* 文件可能刚被删除 */ }
      return { fileName: f, sizeBytes, disabled: f.endsWith('.disabled') };
    });
}
