/**
 * 批量运维：多实例备份 / 模组更新检查 / 实例导出。
 * 每项独立捕获错误，单个实例失败不影响其他实例。
 */
import * as instances from './instances';
import * as backups from './backup';
import * as modrinth from './modrinth';
import * as exporter from './exporter';
import * as minecraft from './minecraft';
import { BatchResult, ExportFormat } from '../shared/types';

function resolveTargets(ids: string[]): Array<{ id: string; name: string }> {
  if (!Array.isArray(ids)) throw new Error('实例列表格式不正确');
  const out: Array<{ id: string; name: string }> = [];
  for (const id of ids) {
    const instance = instances.getInstance(String(id ?? ''));
    if (instance) out.push({ id: instance.id, name: instance.name });
  }
  return out;
}

function isBusy(id: string): boolean {
  return minecraft.launchState.instanceId === id
    && ['preparing', 'downloading', 'launching', 'running'].includes(minecraft.launchState.status);
}

export async function batchBackup(ids: string[]): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const target of resolveTargets(ids)) {
    if (isBusy(target.id)) {
      results.push({ id: target.id, name: target.name, ok: false, message: '实例正在运行，已跳过' });
      continue;
    }
    try {
      const info = await backups.createBackup(target.id, 'auto', '批量备份');
      results.push({
        id: target.id,
        name: target.name,
        ok: !!info,
        message: info ? `已备份 ${info.worldNames.length} 个世界（${Math.round(info.sizeBytes / 1024 / 1024)} MB）` : '没有存档可备份',
      });
    } catch (error) {
      results.push({ id: target.id, name: target.name, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function batchCheckUpdates(ids: string[]): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const target of resolveTargets(ids)) {
    const instance = instances.getInstance(target.id)!;
    if (instance.noModUpdate) {
      results.push({ id: target.id, name: target.name, ok: true, message: '已跳过：该实例禁止自动更新模组' });
      continue;
    }
    try {
      const list = await modrinth.checkModUpdates(target.id, instance.mcVersion, instance.loader === 'vanilla' ? undefined : instance.loader);
      const count = list.filter(item => item.updateAvailable).length;
      results.push({
        id: target.id,
        name: target.name,
        ok: true,
        message: count ? `${count} / ${list.length} 个模组有更新` : `已检查 ${list.length} 个模组，均为最新`,
      });
    } catch (error) {
      results.push({ id: target.id, name: target.name, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function batchExport(ids: string[], format: ExportFormat, destDir: string): Promise<BatchResult[]> {
  if (!destDir) throw new Error('请选择导出目录');
  const results: BatchResult[] = [];
  for (const target of resolveTargets(ids)) {
    if (isBusy(target.id)) {
      results.push({ id: target.id, name: target.name, ok: false, message: '实例正在运行，已跳过' });
      continue;
    }
    try {
      const result = await exporter.exportInstance(target.id, format, destDir);
      results.push({
        id: target.id,
        name: target.name,
        ok: !!result,
        message: result ? `${result.filePath}（${result.files} 个文件）` : '导出未完成',
      });
    } catch (error) {
      results.push({ id: target.id, name: target.name, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
