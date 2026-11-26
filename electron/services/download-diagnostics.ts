/**
 * 下载诊断：把镜像测速结果、实际生效源、代理、缓存与失败任务集中展示。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import * as net from './net';
import { getAutoSource } from './version';
import { getSettings, updateSettings } from './settings';
import { downloadTasks } from './tasks';
import { DownloadDiagnosticReport, DownloadSource } from '../shared/types';

function measureDir(dir: string): { sizeBytes: number; files: number } {
  let sizeBytes = 0;
  let files = 0;
  const walk = (target: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try { sizeBytes += fs.statSync(full).size; files += 1; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { sizeBytes, files };
}

export function getReport(): DownloadDiagnosticReport {
  const settings = getSettings();
  const health = net.lastHealthCheck();
  const effective = getAutoSource();
  const cache = measureDir(paths.cacheDir());
  const failed = downloadTasks.list().filter(task => task.status === 'failed').slice(-5);

  let recommendation = '当前下载源工作正常。';
  if (health && health.latencies.length === 2) {
    const official = health.latencies.find(l => l.source === 'official');
    const bmclapi = health.latencies.find(l => l.source === 'bmclapi');
    if (official && bmclapi && official.ok && bmclapi.ok) {
      const faster = official.latencyMs <= bmclapi.latencyMs ? '官方源' : 'BMCLAPI';
      recommendation = `测速显示 ${faster} 更快（${Math.min(official.latencyMs, bmclapi.latencyMs)} ms）。`
        + (settings.download.source === 'auto'
          ? `当前 auto 模式已自动优先使用${faster}。`
          : `当前手动锁定为「${settings.download.source}」，如需跟随测速请切换到 auto。`);
    } else if (!official?.ok || !bmclapi?.ok) {
      recommendation = '至少一个源测速失败，建议检查代理或网络后重新测速。';
    }
  } else {
    recommendation = '还没有测速记录，点「重新测速」后 auto 模式会自动选更快的源。';
  }

  return {
    checkedAt: Date.now(),
    configuredSource: settings.download.source,
    effectiveSource: effective,
    health: health ? health.latencies.map(l => ({ source: l.source, latencyMs: l.latencyMs, ok: l.ok })) : [],
    lastTestAt: health?.at ?? null,
    proxyEnabled: settings.network.proxyMode !== 'off' && !!settings.network.proxyUrl.trim(),
    proxyAppliedToDownloads: settings.network.applyToDownloads,
    cacheDir: paths.cacheDir(),
    cacheSizeBytes: cache.sizeBytes,
    cacheFiles: cache.files,
    recentFailures: failed.map(task => ({
      name: task.name,
      error: task.error ?? '未知错误',
      finishedAt: task.finishedAt ?? task.startedAt,
    })),
    recommendation,
  };
}

export async function probeMirrors(): Promise<DownloadDiagnosticReport> {
  const settings = getSettings();
  await net.pickBestSource(settings.download.customMirror || undefined);
  return getReport();
}

export function setSource(source: DownloadSource): DownloadDiagnosticReport {
  if (!['auto', 'bmclapi', 'official', 'custom'].includes(source)) throw new Error('不支持的下载源');
  const settings = getSettings();
  if (source === 'custom' && !settings.download.customMirror.trim()) {
    throw new Error('请先在设置里填写自定义镜像地址');
  }
  updateSettings({ download: { source } });
  return getReport();
}
