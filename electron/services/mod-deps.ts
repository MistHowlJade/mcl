/**
 * 模组依赖体检：扫描已装模组的 Modrinth required dependencies，列出缺失前置并一键补装。
 * installMod 本身会递归安装 required 前置，因此补装只针对当前确实缺失的项目。
 */
import { fetchJson, USER_AGENT } from './net';
import { getInstance } from './instances';
import * as modrinth from './modrinth';
import { InstalledMod, MissingModDependency, ModDependencyReport } from '../shared/types';

const API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

interface RemoteVersion {
  id: string;
  version_number: string;
  dependencies?: Array<{ project_id?: string | null; version_id?: string | null; dependency_type: string }>;
}

async function projectTitle(projectId: string): Promise<string> {
  try {
    const project = await fetchJson<{ title?: string }>(`${API}/project/${projectId}`, { timeoutMs: 12000, headers: HEADERS });
    return project.title || projectId;
  } catch {
    return projectId;
  }
}

export async function scanDependencies(instanceId: string): Promise<ModDependencyReport> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const installed: InstalledMod[] = modrinth.readInstalledMods(instanceId);
  const owned = new Set(installed.map(mod => mod.projectId).filter((id): id is string => !!id));
  const missing = new Map<string, MissingModDependency>();

  // 限制扫描数量：一个整合包几百个模组时不能发几百个请求
  const candidates = installed.filter(mod => mod.projectId).slice(0, 30);
  for (const mod of candidates) {
    let versions: RemoteVersion[] = [];
    try {
      versions = await fetchJson<RemoteVersion[]>(`${API}/project/${mod.projectId}/version`, { timeoutMs: 15000, headers: HEADERS });
    } catch {
      continue; // 单个项目查询失败不影响整体扫描
    }
    const target = versions.find(v => v.id === mod.versionId)
      || versions.find(v => v.version_number === mod.versionNumber)
      || versions[0];
    if (!target) continue;
    for (const dep of target.dependencies ?? []) {
      if (dep.dependency_type !== 'required' || !dep.project_id || owned.has(dep.project_id) || missing.has(dep.project_id)) continue;
      missing.set(dep.project_id, {
        projectId: dep.project_id,
        title: await projectTitle(dep.project_id),
        requiredBy: mod.title || mod.fileName,
        versionId: dep.version_id,
        loader: instance.loader === 'vanilla' ? undefined : instance.loader,
        gameVersion: instance.mcVersion,
      });
    }
  }

  return {
    instanceId,
    scanned: candidates.length,
    missing: [...missing.values()],
    checkedAt: Date.now(),
    note: installed.length > candidates.length
      ? `只扫描了前 ${candidates.length} 个带 Modrinth 信息的模组（共 ${installed.length} 个）`
      : undefined,
  };
}

export async function installDependencies(instanceId: string, items: Array<{ projectId: string; versionId?: string | null }>): Promise<Array<{ projectId: string; fileName: string; title: string }>> {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  if (!Array.isArray(items) || !items.length) return [];
  const saved: Array<{ projectId: string; fileName: string; title: string }> = [];
  for (const item of items.slice(0, 20)) {
    const projectId = String(item?.projectId ?? '');
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error(`非法的 Modrinth 项目 ID：${projectId}`);
    const result = await modrinth.installMod(instanceId, projectId, item.versionId ?? undefined, {
      loader: instance.loader === 'vanilla' ? undefined : instance.loader,
      gameVersion: instance.mcVersion,
    });
    saved.push({
      projectId,
      fileName: result.primary.fileName,
      title: result.primary.title || projectId,
    });
  }
  return saved;
}
