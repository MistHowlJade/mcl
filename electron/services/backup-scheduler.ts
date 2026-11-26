/**
 * 定时存档备份：按设置的小时间隔为所有空闲实例创建自动备份。
 * 定时器由 main.ts 在 app ready 后启动；不在模块加载时启动，避免测试环境产生副作用。
 */
import * as path from 'path';
import * as paths from './paths';
import * as instances from './instances';
import * as backups from './backup';
import * as minecraft from './minecraft';
import { getSettings, updateSettings } from './settings';
import { readJson, writeJson } from './store';
import { BackupScheduleState } from '../shared/types';

const stateFile = () => path.join(paths.dataRoot(), 'backup-schedule.json');

interface StoredState { lastRunAt: number | null }

function readState(): StoredState {
  const raw = readJson<Partial<StoredState>>(stateFile(), {});
  return { lastRunAt: typeof raw?.lastRunAt === 'number' && Number.isFinite(raw.lastRunAt) ? raw.lastRunAt : null };
}

function writeState(lastRunAt: number): void {
  writeJson(stateFile(), { lastRunAt });
}

export function getState(): BackupScheduleState {
  const general = getSettings().general;
  const lastRunAt = readState().lastRunAt;
  const intervalHours = general.scheduledBackupIntervalHours;
  return {
    enabled: general.scheduledBackupEnabled,
    intervalHours,
    lastRunAt,
    nextRunAt: lastRunAt === null ? null : lastRunAt + intervalHours * 3600_000,
  };
}

export function updateSchedule(patch: { enabled?: boolean; intervalHours?: number }): BackupScheduleState {
  const current = getSettings().general;
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.scheduledBackupEnabled;
  const intervalHours = Number(patch.intervalHours);
  const hours = Number.isFinite(intervalHours) && intervalHours >= 1 && intervalHours <= 168
    ? Math.floor(intervalHours)
    : current.scheduledBackupIntervalHours;
  updateSettings({ general: { scheduledBackupEnabled: enabled, scheduledBackupIntervalHours: hours } });
  resetTimer();
  return getState();
}

export async function runNow(instanceId?: string): Promise<{ created: number; skipped: string[] }> {
  const targets = instanceId
    ? instances.listInstanceFiles().filter(item => item.id === instanceId)
    : instances.listInstanceFiles();
  const created: string[] = [];
  const skipped: string[] = [];
  for (const instance of targets) {
    if (minecraft.launchState.instanceId === instance.id && ['preparing', 'downloading', 'launching', 'running'].includes(minecraft.launchState.status)) {
      skipped.push(`${instance.name}（正在运行）`);
      continue;
    }
    try {
      const info = await backups.createBackup(instance.id, 'auto', '定时备份');
      if (info) created.push(instance.name);
      else skipped.push(`${instance.name}（没有存档）`);
    } catch (error) {
      skipped.push(`${instance.name}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  if (created.length) writeState(Date.now());
  return { created: created.length, skipped };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function resetTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const state = getState();
  if (!state.enabled) return;
  const handle = setInterval(() => {
    const current = getState();
    if (!current.enabled) return;
    if (current.lastRunAt !== null && Date.now() - current.lastRunAt < current.intervalHours * 3600_000) return;
    void runNow().catch(() => undefined);
  }, 60_000);
  timer = handle;
  // 不阻塞进程退出
  if (typeof handle.unref === 'function') handle.unref();
}

export function startScheduler(): void {
  resetTimer();
}
