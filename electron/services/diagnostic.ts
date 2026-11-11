/**
 * 诊断包导出（痛点 #30：报障要日志时玩家找不到）
 * 内容：最近日志 + 崩溃报告 + 系统环境 + 实例清单 + 设置（已脱敏 token）
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dialog, shell } from 'electron';
import { zipFromFiles } from './zip';
import * as paths from './paths';
import { getSettings } from './settings';
import { listInstances } from './instances';
import { detectSystemJavas } from './java';
import { readJson } from './store';
import { AppSettings } from '../shared/types';

function sanitizeSettings(settings: AppSettings): AppSettings {
  const clone = JSON.parse(JSON.stringify(settings)) as AppSettings;
  if (clone.curseforge.apiKey) clone.curseforge.apiKey = '<已隐藏>';
  return clone;
}

export interface EnvironmentReportLite {
  os: string; release: string; arch: string;
  totalMemoryMB: number; freeMemoryMB: number;
  cpuCores: number; hostnameHidden: string;
}

export function environmentReport(): EnvironmentReportLite {
  return {
    os: `${os.type()} ${os.release()}`,
    release: os.release(),
    arch: os.arch(),
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    cpuCores: os.cpus().length,
    hostnameHidden: '***',
  };
}

export async function exportDiagnostic(instanceId?: string | null): Promise<string | null> {
  // 先弹保存对话框（用户取消就什么都不做，不白做全量打包）
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出诊断包',
    defaultPath: `mcl-diagnostic-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return null;

  const files: Array<{ name: string; absPath: string }> = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-diag-'));
  const writeTmp = (name: string, content: string | Buffer): string => {
    const p = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  };

  // 1) 日志（最近 20 个）
  if (fs.existsSync(paths.logsDir())) {
    const logs = fs.readdirSync(paths.logsDir()).filter(f => f.endsWith('.log') || f.endsWith('.txt')).map(f => ({ f, m: fs.statSync(path.join(paths.logsDir(), f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 20);
    for (const { f } of logs) files.push({ name: `logs/${f}`, absPath: path.join(paths.logsDir(), f) });
  }
  // 2) 崩溃报告（最近 5 个）
  if (instanceId) {
    const crashDir = path.join(paths.gameDir(instanceId), 'crash-reports');
    if (fs.existsSync(crashDir)) {
      const crashes = fs.readdirSync(crashDir).filter(f => f.endsWith('.txt')).map(f => ({ f, m: fs.statSync(path.join(crashDir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, 5);
      for (const { f } of crashes) files.push({ name: `crash-reports/${f}`, absPath: path.join(crashDir, f) });
    }
    const latestLog = path.join(paths.gameDir(instanceId), 'logs', 'latest.log');
    if (fs.existsSync(latestLog)) files.push({ name: 'game-logs/latest.log', absPath: latestLog });
  }
  // 3) 环境与设置（脱敏）
  files.push({ name: 'environment.json', absPath: writeTmp('environment.json', JSON.stringify(environmentReport(), null, 2)) });
  files.push({ name: 'settings.json', absPath: writeTmp('settings.json', JSON.stringify(sanitizeSettings(getSettings()), null, 2)) });
  const instances = listInstances().map(i => ({ id: i.id, name: i.name, mcVersion: i.mcVersion, loader: i.loader, loaderVersion: i.loaderVersion, memoryPreset: i.memoryPreset, modsCount: i.modsCount }));
  files.push({ name: 'instances.json', absPath: writeTmp('instances.json', JSON.stringify(instances, null, 2)) });
  try {
    const javas = await detectSystemJavas();
    files.push({ name: 'javas.json', absPath: writeTmp('javas.json', JSON.stringify(javas, null, 2)) });
  } catch { /* 检测失败也不阻塞导出 */ }

  const buffer = zipFromFiles(files);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.writeFileSync(filePath, buffer);
  shell.showItemInFolder(filePath);
  return filePath;
}
